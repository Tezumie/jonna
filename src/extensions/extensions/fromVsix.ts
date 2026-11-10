// Install from a .vsix file (VS Code's "Install from VSIX…"): the package is a ZIP archive that
// Rust unpacks into a scratch folder (`extensions/vsix.rs`); the extension folder in it
// (`extension/`, with the VS Code package.json) is installed like a folder, then the scratch
// folder goes. Its themes, grammars, snippets and settings work at once; its code, once allowed,
// runs in the Node host behind the `vscode` shim (D256), as for any VS Code extension.
import { extIpc } from "../../core/ipc/extensions";
import { dialogIpc } from "../../core/ipc/system";
import { isAbsolute, joinPath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { ExtensionManager } from "./manager";

type Register = WorkbenchServices["dispatcher"]["register"];

/** The extension folder of an unpacked .vsix: `extension` (VS Code's layout), else the first. */
export function vsixExtensionFolder(found: readonly string[]): string | undefined {
  return found.find((f) => f === "extension") ?? found[0];
}

export function registerFromVsix(
  services: WorkbenchServices,
  manager: ExtensionManager,
  register: Register,
): void {
  register({
    id: "extensions.installFromVsix",
    title: "Install from VSIX…",
    description:
      "Installs an extension from a .vsix file (VS Code's extension package): unpacks it, installs the extension folder in it and asks the user to grant the permissions it asks for. Without `file`, asks for one. VS Code extensions' themes, languages, grammars, snippets and settings work at once; their code runs in Node.js once the user allows it (most of VS Code's API; D256).",
    input: s.object({
      file: s
        .string()
        .describe("Path of the .vsix file (absolute, or relative to the open folder)")
        .optional(),
      with: s
        .string()
        .describe(
          "Installed along with this extension, whose permissions the user just granted (its pack or dependencies): granted the same, without a dialog of its own",
        )
        .optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ file, with: along }, ctx) => {
      const root = services.workspace.root.peek();
      const path =
        file === undefined
          ? await dialogIpc.pickFile("Install from VSIX", undefined, [
              { name: "Extension packages", extensions: ["vsix"] },
            ])
          : root && !isAbsolute(file)
            ? services.workspace.resolve(file)
            : file;
      if (!path) return { id: null };
      const line = services.statusBar.add({
        id: "extensions.download",
        name: "Extension downloads",
        alignment: "left",
        priority: 95,
        text: () => "$(cloud-download) Installing from VSIX…",
        tooltip: () => path,
      });
      let folder: string | null = null;
      try {
        const unpacked = await extIpc.unpackVsix(path);
        folder = unpacked.folder;
        const rel = vsixExtensionFolder(unpacked.extensions);
        if (rel === undefined)
          throw new Error(
            'This .vsix holds no extension (no package.json with "engines.vscode" and "contributes").',
          );
        // Along with an extension the user allowed (only the user's, or a test's, call can say
        // so: the command is hidden from agents and extensions).
        const along_ =
          !!along &&
          (ctx.caller.kind === "user" || ctx.caller.kind === "test") &&
          (manager.get(along)?.manifest?.permissions ?? []).every((p) =>
            manager.granted(along).includes(p),
          );
        const id = await manager.installFrom(
          joinPath(folder, rel),
          ctx.caller.kind !== "test",
          along_,
        );
        // Cancelled when asked about its permissions (D259): nothing was installed.
        if (!id) return { id: null, cancelled: true };
        // From a file now: no longer updated from a repository it may have come from.
        await manager.setSource(id, undefined);
        if (!along_)
          services.notifications.show(
            "success",
            `Installed ${manager.get(id)?.manifest?.displayName ?? id}.`,
          );
        return { id };
      } finally {
        line.dispose();
        if (folder) void extIpc.discardDownload(folder).catch(() => {});
      }
    },
  });
}
