// New file, new folder, rename and delete in an extension's file system (D234): its Explorer
// section's buttons and row menu run these, and agents can too. Each goes through the extension's
// provider (VS Code's FileSystemProvider writeFile / createDirectory / rename / delete); a
// read-only one refuses. Afterwards the section and open editors hear of the change, and editor
// tabs follow a rename or close on a delete (the files.* events, as for the folder's own files).
import { s } from "../../core/schema/index";
import {
  childUri,
  type FileSystemEntry,
  fileNameProblem,
  makeUri,
  parentUri,
  uriPath,
  uriScheme,
} from "../../workbench/extensionRegistries";
import type { WorkbenchServices } from "../../workbench/services";

export function registerFileSystemCommands(
  services: WorkbenchServices,
  register: WorkbenchServices["dispatcher"]["register"],
): void {
  const { quickInput, events, dispatcher } = services;
  const registry = services.extensionFeatures.fileSystems;

  /** The provider of `uri` (normalized), or a readable error. */
  const served = (uri: string): { entry: FileSystemEntry; uri: string } => {
    const scheme = uriScheme(uri);
    const entry = scheme ? registry.get(uri) : undefined;
    if (!scheme || !entry)
      throw new Error(
        `${uri} isn't a file of an extension's file system (ide://extensions/providers).`,
      );
    if (entry.readonly) throw new Error(`${entry.label} is read-only.`);
    return { entry, uri: makeUri(scheme, uri) };
  };

  /** `name`, or the user's answer; null when they cancel. */
  const askName = async (
    name: string | undefined,
    prompt: string,
    value = "",
  ): Promise<string | null> => {
    if (name !== undefined) {
      const problem = fileNameProblem(name);
      if (problem) throw new Error(problem);
      return name.trim();
    }
    const dot = value.lastIndexOf(".");
    const answer = await quickInput.prompt({
      prompt,
      value,
      ...(value && { selection: [0, dot > 0 ? dot : value.length] as [number, number] }),
      validate: (v) => fileNameProblem(v) ?? undefined,
    });
    return answer === undefined ? null : answer.trim();
  };

  const exists = (entry: FileSystemEntry, uri: string) =>
    entry.stat(uri).then(
      () => true,
      () => false,
    );

  const folderInput = s
    .string()
    .describe('The folder, a URI of the extension\'s scheme ("memfs:/notes"; default its root)');
  const pathInput = s
    .string()
    .describe('A file or folder of the extension\'s scheme ("memfs:/a.txt")');

  const create = async (kind: "file" | "folder", folder: string, name: string | undefined) => {
    const { entry, uri: dir } = served(folder);
    const chosen = await askName(name, kind === "file" ? "New file name" : "New folder name");
    if (chosen === null) return { cancelled: true };
    const uri = childUri(dir, chosen);
    if (await exists(entry, uri)) throw new Error(`${chosen} exists already.`);
    if (kind === "file") await entry.writeFile(uri, new Uint8Array());
    else await entry.createDirectory(uri);
    registry.fireChanges([{ path: uri, kind: "created" }]);
    if (kind === "file") await dispatcher.execute("editor.openFile", { path: uri });
    return { path: uri };
  };

  register({
    id: "extensions.fsNewFile",
    title: "New file in an extension's file system",
    description:
      "Creates an empty file in a folder of an extension's file system (through the extension) and opens it; asks for the name when not given.",
    input: s.object({
      folder: folderInput,
      name: s.string().describe("The new file's name (default: asks)").optional(),
    }),
    effects: ["write"],
    palette: false,
    run: ({ folder, name }) => create("file", folder, name),
  });
  register({
    id: "extensions.fsNewFolder",
    title: "New folder in an extension's file system",
    description:
      "Creates a folder in an extension's file system (through the extension); asks for the name when not given.",
    input: s.object({
      folder: folderInput,
      name: s.string().describe("The new folder's name (default: asks)").optional(),
    }),
    effects: ["write"],
    palette: false,
    run: ({ folder, name }) => create("folder", folder, name),
  });
  register({
    id: "extensions.fsRename",
    title: "Rename in an extension's file system",
    description:
      "Renames a file or folder of an extension's file system (in its folder; through the extension). Open tabs follow it.",
    input: s.object({
      path: pathInput,
      newName: s.string().describe("The new name (default: asks)").optional(),
    }),
    effects: ["write"],
    palette: false,
    run: async ({ path, newName }) => {
      const { entry, uri } = served(path);
      if (uriPath(uri) === "/") throw new Error("The root can't be renamed.");
      const old = uriPath(uri).split("/").pop() ?? "";
      const chosen = await askName(newName, `Rename ${old}`, old);
      if (chosen === null || chosen === old) return { path: uri };
      const to = childUri(parentUri(uri), chosen);
      if (await exists(entry, to)) throw new Error(`${chosen} exists already.`);
      await entry.rename(uri, to, false);
      events.emit("files.didRename", { from: uri, to });
      registry.fireChanges([
        { path: uri, kind: "deleted" },
        { path: to, kind: "created" },
      ]);
      return { path: to };
    },
  });
  register({
    id: "extensions.fsDelete",
    title: "Delete in an extension's file system",
    description:
      "Deletes a file or folder (with what's in it) of an extension's file system, through the extension. The user is asked first.",
    input: s.object({ path: pathInput }),
    effects: ["destructive"],
    palette: false,
    // The dispatcher asks the user (and agents' approval) before it runs.
    confirm: ({ path }) =>
      `Delete ${path}? The extension serving it deletes it; this can't be undone here.`,
    run: async ({ path }) => {
      const { entry, uri } = served(path);
      if (uriPath(uri) === "/") throw new Error("The root can't be deleted.");
      await entry.delete(uri, true);
      events.emit("files.didDelete", { path: uri });
      registry.fireChanges([{ path: uri, kind: "deleted" }]);
      return { deleted: true, path: uri };
    },
  });
}
