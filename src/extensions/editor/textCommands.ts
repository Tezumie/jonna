// Reading and changing a file's text as the editor has it (D176): what extensions' ide.editor.text
// / replace use, and agents too. An open document is read and changed with its unsaved edits (a
// change is one undoable edit, not saved); a closed file is read and written on disk.
import { fsIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import { applyRangeEdit } from "../../workbench/extensionFeatures";
import { fileSystems, makeUri, uriScheme } from "../../workbench/extensionRegistries";
import type { WorkbenchServices } from "../../workbench/services";
import { decodeFile } from "./diskText";
import { encodeWith } from "./encodings";
import type { EditorService } from "./service";
import type { EditorView } from "./view";

/** A file's bytes, through the extension serving its URI when it has one. */
function readBytes(path: string): Promise<Uint8Array> {
  return fileSystems.get(path)?.readFile(path) ?? fsIpc.read(path);
}

export function registerTextCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  editors: EditorService,
  activeView: () => EditorView | undefined,
): void {
  const { dispatcher } = services;
  /** `path` (relative to the folder, or absolute inside it), or the active editor's file. */
  const target = (path: string | undefined): string => {
    const { workspace } = services;
    const given = path ?? activeView()?.doc?.path.peek();
    if (!given) throw new Error("Give a path (no text editor is active).");
    // A file of an extension's file system (D233, D234): read and written through it.
    const scheme = uriScheme(given);
    if (scheme) {
      if (!fileSystems.get(given)) throw new Error(`No extension serves ${scheme}: files.`);
      return makeUri(scheme, given);
    }
    // Only files of the workspace's folders (an untitled or outside file has no business here).
    if (!workspace.root.peek()) throw new Error("No folder is open.");
    const full = workspace.resolve(given);
    if (!workspace.contains(full))
      throw new Error(
        workspace.isMultiRoot()
          ? `${given} is outside the workspace's folders.`
          : `${given} is outside the open folder.`,
      );
    return full;
  };

  sub.add(
    dispatcher.register({
      id: "editor.getText",
      title: "Get file text",
      category: "Editor",
      description:
        "The text of a file as the editor has it: an open file with its unsaved changes, otherwise the file on disk (`path` relative to the folder, or a URI of an extension's file system such as memfs:/a.txt; default: the active editor).",
      input: s.object({ path: s.string().optional() }),
      effects: ["read"],
      palette: false,
      run: async ({ path }) => {
        const full = target(path);
        const open = editors.find(full)?.model.peek();
        const text = open ? open.getText() : new TextDecoder().decode(await readBytes(full));
        return { path: full, text, open: !!open };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "editor.replaceRange",
      title: "Replace text range",
      category: "Editor",
      description:
        "Replaces a range of a file with `text` (1-based lines and columns, end column exclusive; no columns: whole lines). An open file changes in the editor (undoable, not saved); a closed one on disk. Default file: the active editor.",
      input: s.object({
        path: s.string().optional(),
        startLine: s.integer({ min: 1 }),
        startColumn: s.integer({ min: 1 }).optional(),
        endLine: s.integer({ min: 1 }).optional(),
        endColumn: s.integer({ min: 1 }).optional(),
        text: s.string(),
      }),
      effects: ["write"],
      palette: false,
      run: async ({ path, text, startLine, startColumn, endLine, endColumn }, ctx) => {
        // Agents change files with their edit tools, which go through review and checkpoints.
        if (ctx.caller.kind === "agent" || ctx.caller.kind === "acp")
          throw new Error("Agents edit files with their edit tools (reviewed), not this command.");
        const full = target(path);
        const range = {
          startLine,
          ...(startColumn !== undefined && { startColumn }),
          ...(endLine !== undefined && { endLine }),
          ...(endColumn !== undefined && { endColumn }),
        };
        const model = editors.find(full)?.model.peek();
        if (model) {
          if (model.readOnly) throw new Error("The file is read-only.");
          model.replaceText(applyRangeEdit(model.getText(), range, text));
          return { path: full, inEditor: true };
        }
        // Written back as it was read: a BOM and UTF-16 kept; a file that isn't text, or isn't
        // UTF-8, is refused (decoding it replaced bytes, so writing it would damage it).
        const disk = decodeFile(await readBytes(full));
        if (disk.binary || disk.notUtf8)
          throw new Error(`${full} isn't UTF-8 text: open it in the editor to change it.`);
        const after = encodeWith(applyRangeEdit(disk.text, range, text), disk.encoding);
        const provided = fileSystems.get(full);
        if (provided) {
          await provided.writeFile(full, after);
          fileSystems.fireChanges([{ path: full, kind: "changed" }]);
        } else {
          await fsIpc.write(full, after);
          services.events.emit("files.didChange", { path: full });
        }
        return { path: full, inEditor: false };
      },
    }),
  );
}
