// Launch configurations (D143, D189, D207): launch.json in every workspace folder (the IDE's
// own first), its compounds, the active file's default configuration, the picker's entries and
// how a start request picks one. Shared by the start commands, the view and the session
// commands. A multi-root workspace (D251) reads every folder's launch.json and the workspace
// file's `launch`; a folder's configurations are named with it ("Launch (api)", as VS Code's
// picker shows them) and their `${workspaceFolder}` is that folder.
import { fsIpc } from "../../core/ipc/fs";
import { basename, isAbsolute } from "../../core/paths/index";
import { parseJsonc } from "../../core/settings/jsonc";
import type { WorkbenchServices } from "../../workbench/services";
import type { WorkspaceFolder } from "../../workbench/workspace";
import { workspaceFolderLabelsOf, workspaceFolderPaths } from "../../workbench/workspaceFolder";
import { editorFolder } from "../tasks/chooseFolder";
import { configFilesOf, folderForFile } from "../tasks/folders";
import type { Variables } from "../tasks/tasks";
import { type Compound, findConfig, ownLaunchEntries, parseCompounds } from "./compounds";
import { configForFile, type LaunchConfig, parseLaunchJson, toConfig } from "./launch";
import { parsePresentation, startsGroup, visibleAndSorted } from "./presentation";
import { COMPOUND_PREFIX, type ConfigChoice } from "./view";

export type DebugConfigurations = ReturnType<typeof debugConfigurations>;

export function debugConfigurations(services: WorkbenchServices) {
  const { state, workspace, settings } = services;
  const root = () => workspace.root.peek();
  // Paths shown and read back (breakpoints, programs): the workspace's (a folder's name in front
  // in a multi-root one, D251).
  const rel = (p: string) => (root() ? workspace.relative(p) : p);
  const abs = (p: string) => (root() && !isAbsolute(p) ? workspace.resolve(p) : p);
  /** The open folders (the root alone while a workspace is still being set up). */
  const openFolders = (): readonly WorkspaceFolder[] => {
    const folders = workspace.folders.peek();
    const r = root();
    if (folders.length || !r) return folders;
    return [{ path: r, name: basename(r) || r, index: 0 }];
  };

  /** The active editor's file and cursor (absolute path, 1-based line). */
  const activeEditor = async (): Promise<{ path: string; line: number } | null> => {
    const snap = await state.get("ide://editors/active").catch(() => null);
    const v = snap?.value as { absolutePath?: string | null; cursor?: { line: number } } | null;
    return v?.absolutePath ? { path: v.absolutePath, line: v.cursor?.line ?? 1 } : null;
  };

  // ---- Configurations ----
  // A folder's launch.json files, highest precedence first (D189).
  const launchFiles = (r: string): [string, string][] => {
    const labels = workspaceFolderLabelsOf(r, "launch.json");
    return workspaceFolderPaths(r, "launch.json").map((path, i) => [path, labels[i] ?? path]);
  };
  /**
   * Variables for `folder`'s configurations; without one, the active file's folder (else the
   * first): the workspace file's, given and made-up configurations.
   */
  const variables = async (folder?: string): Promise<Variables | null> => {
    const r = root();
    if (!r) return null;
    const active = await activeEditor();
    const folders = openFolders();
    const own = folder ?? folderForFile(folders, active?.path, folders[0])?.path ?? r;
    return {
      workspaceFolder: own,
      folders,
      ...(active ? { file: active.path, lineNumber: active.line } : {}),
      pathSeparator: services.platform === "windows" ? "\\" : "/",
      config: (key: string) => settings.peekAt(key, own),
    };
  };
  /**
   * launch.json configurations and compounds of every folder (the IDE's file first; the first
   * name wins), the workspace file's, then the active file's.
   */
  const configurations = async (): Promise<{
    list: LaunchConfig[];
    file: LaunchConfig | null;
    compounds: Compound[];
  }> => {
    const r = root();
    const v = await variables();
    if (!r || !v) return { list: [], file: null, compounds: [] };
    const folders = openFolders();
    const multi = folders.length > 1;
    const list: LaunchConfig[] = [];
    const compounds: Compound[] = [];
    const add = (
      json: unknown,
      source: string,
      vars: Variables,
      folderName: string | undefined,
    ) => {
      const own = ownLaunchEntries(
        parseLaunchJson(json, source, vars),
        parseCompounds(json, source, vars),
        vars.workspaceFolder,
        folderName,
        multi,
      );
      for (const c of own.configs) if (!list.some((x) => x.name === c.name)) list.push(c);
      for (const c of own.compounds)
        if (!compounds.some((x) => x.name === c.name)) compounds.push(c);
    };
    for (const f of configFilesOf(folders, launchFiles)) {
      const text = await fsIpc.read(f.path).then(
        (b) => new TextDecoder().decode(b),
        () => null,
      );
      if (text === null) continue;
      const parsed = parseJsonc(text);
      if (!parsed.ok) continue;
      const vars = await variables(f.folder.path);
      if (vars) add(parsed.value, f.source, vars, f.folder.name);
    }
    // The workspace file's `launch` (D251): for the active file's folder.
    const workspaceFile = workspace.file.peek();
    const launch = workspace.fileData.peek()?.launch;
    if (workspaceFile && launch) add(launch, basename(workspaceFile), v, undefined);
    const file = v.file ? configForFile(v.file, v) : null;
    return {
      list,
      file: file && { ...file, workspaceFolder: v.workspaceFolder },
      compounds,
    };
  };
  /** The picker's entries: launch.json's by `presentation` (hidden ones left out; D207). */
  const choices = async (): Promise<ConfigChoice[]> => {
    const { list, file, compounds } = await configurations();
    const sorted = visibleAndSorted([
      ...list.map((c) => ({
        name: c.name,
        label: c.name,
        detail: c.source,
        presentation: parsePresentation(c.raw.presentation),
      })),
      ...compounds.map((c) => ({
        name: `${COMPOUND_PREFIX}${c.name}`,
        label: c.name,
        detail: `Compound: ${c.configurations.join(", ")}`,
        presentation: c.presentation,
      })),
    ]);
    return [
      ...sorted.map((c, i) => ({
        name: c.name,
        label: c.label,
        detail: c.detail,
        ...(startsGroup(sorted, i) && { separatorBefore: true }),
      })),
      ...(file
        ? [
            {
              name: "",
              label: file.name,
              detail: "The active file",
              ...(sorted.length > 0 && { separatorBefore: true }),
            },
          ]
        : []),
    ];
  };
  /** A configuration given whole (`configuration`), variables filled in. */
  const givenConfig = async (json: unknown): Promise<LaunchConfig> => {
    const v = await variables();
    const c = v ? toConfig(json, "given", v) : null;
    if (!c) throw new Error("The configuration needs a name and a type.");
    return v ? { ...c, workspaceFolder: v.workspaceFolder } : c;
  };
  const resolveConfig = async (
    name: string | undefined,
    program: string | undefined,
    user: boolean,
    /** The folder whose launch.json `name` is looked up in first (an extension's own). */
    folder?: string,
  ): Promise<LaunchConfig> => {
    const { list, file } = await configurations();
    if (program) {
      const path = abs(program);
      // The program's own folder (D251).
      const v = await variables(workspace.folderOf(path)?.path);
      const c = v ? configForFile(path, v) : null;
      if (!c)
        throw new Error(
          `No debugger for ${program}: use a .js, .ts or .py file, or a launch.json configuration.`,
        );
      return v ? { ...c, workspaceFolder: v.workspaceFolder } : c;
    }
    if (name === "") {
      if (!file) throw new Error("The active file can't be debugged: open a .js, .ts or .py file.");
      return file;
    }
    if (name) {
      const c = findConfig(list, name, folder ?? (user ? editorFolder(services) : undefined));
      if (!c)
        throw new Error(`No launch configuration "${name}" (debug.listConfigurations lists them).`);
      return c;
    }
    if (list.length === 1 && !file) return list[0] as LaunchConfig;
    if (user && list.length + (file ? 1 : 0) > 1) {
      const shown = visibleAndSorted(
        list.map((c) => ({ c, presentation: parsePresentation(c.raw.presentation) })),
      );
      const items = [
        ...shown.map(({ c }, i) => ({
          id: c.name,
          label: c.name,
          description: c.source,
          ...(startsGroup(shown, i) && { separator: "" }),
        })),
        ...(file ? [{ id: "", label: file.name, description: "The active file" }] : []),
      ];
      const picked = await services.quickInput.pick(items, {
        placeholder: "Select a configuration to debug",
      });
      if (!picked) throw new Error("Cancelled.");
      const c = picked.id ? list.find((x) => x.name === picked.id) : file;
      if (c) return c;
    }
    const c = list[0] ?? file;
    if (!c)
      throw new Error(
        "Nothing to debug: open a .js, .ts or .py file, or add a configuration (debug.openLaunchJson).",
      );
    return c;
  };
  return {
    root,
    rel,
    abs,
    openFolders,
    activeEditor,
    launchFiles,
    variables,
    configurations,
    choices,
    givenConfig,
    resolveConfig,
  };
}
