// Untitled documents (D126): File → New text file (Ctrl/Cmd+N) opens an empty "Untitled-N"
// editor; saving it asks where (a name from its first line), then the same tab becomes that file.
// With no folder open, the file's folder opens as the workspace (files are reachable inside it).
// A file named on the command line that doesn't exist yet opens as an untitled editor named after
// it (`path`), and saving writes it there without asking, in or outside the folder (VS Code).

import { fsIpc } from "../../core/ipc/fs";
import { appIpc, dialogIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { dirname, isAbsolute, joinPath, pathKey } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { EditorDocument, EditorService } from "./service";
import { isUntitled, suggestedName, untitledFor, untitledName, untitledTarget } from "./untitled";

export function registerUntitled(
  sub: DisposableStore,
  services: WorkbenchServices,
  editors: EditorService,
): void {
  const { dispatcher, workspace } = services;
  /**
   * Untitled editors the user opened for a path (newUntitledFile with `path`): only these save
   * there without asking. An `untitled:<path>` document anyone else opens (editor.openFile from
   * an agent or MCP) saves through the dialog like any untitled editor.
   */
  const userTargets = new Set<string>();

  sub.add(
    dispatcher.register({
      id: "workspace.newUntitledFile",
      title: "New text file",
      category: "File",
      description:
        "Opens a new untitled editor (optionally with `text`); saving it asks where to put it. Works with no folder open. With `path` (a file that doesn't exist yet, absolute; the user's own, as from the command line), the editor is named after it and saving writes there without asking.",
      input: s.object({
        text: s.string().describe("Initial text").optional(),
        path: s
          .string()
          .describe(
            "A file that doesn't exist yet (absolute, or in the folder): where saving writes",
          )
          .optional(),
      }),
      effects: [],
      agent: "hidden",
      run: async ({ text, path: asked }, ctx) => {
        const root = workspace.root.peek();
        const target = asked === undefined || !root ? asked : workspace.resolve(asked);
        if (target !== undefined) {
          // Saving writes outside the folder without asking: only for the user's own paths.
          if (ctx.caller.kind !== "user" && ctx.caller.kind !== "test")
            throw new Error("Only the user can open an untitled editor for a path.");
          if (!isAbsolute(target)) throw new Error("`path` must be absolute (no folder is open).");
        }
        if (target) userTargets.add(untitledFor(target));
        const doc = target
          ? await editors.load(untitledFor(target))
          : editors.createUntitled(text ?? "");
        if (target && text) doc.model.peek()?.replaceText(text);
        const path = doc.path.peek();
        const opened = await dispatcher.execute<{ tabId?: string }>("editor.openFile", { path });
        return {
          path,
          name: untitledName(path),
          ...(target && { saveTo: target }),
          ...(opened?.tabId && { tabId: opened.tabId }),
        };
      },
    }),
  );

  /** Writes untitled `doc` to `to` (asked for when missing); the tab becomes that file. */
  const saveUntitled = async (doc: EditorDocument, to?: string) => {
    const model = doc.model.peek();
    if (!model) throw new Error("The editor isn't ready yet.");
    const text = model.getText();
    const from = doc.path.peek();
    const root = workspace.root.peek();
    const target = userTargets.has(from) ? untitledTarget(from) : null;
    // Its own path (from the command line): written there, in or outside the folder.
    if (target && (to === undefined || pathKey(to) === pathKey(target))) {
      // Any of the workspace's folders is inside (D251).
      const outside = !workspace.contains(target);
      if (editors.find(target)) throw new Error(`${target} is open already; save it there.`);
      if (outside) await fsIpc.allowFile(target);
      // Created meanwhile (it didn't exist when the editor opened): replaced only when asked.
      const exists = await fsIpc.stat(target).then(
        () => true,
        () => false,
      );
      if (exists) {
        const pick = await services.quickInput.pick(
          [
            { id: "replace", label: `Replace ${untitledName(from)}` },
            { id: "cancel", label: "Cancel" },
          ],
          { placeholder: `${target} exists now. Replace it?` },
        );
        if (pick?.id !== "replace") throw new Error("Save cancelled.");
      }
      await fsIpc.write(target, new TextEncoder().encode(text));
      editors.adopt(doc, target);
      // A file from outside the folder is remembered as one (reopened with the window).
      if (outside) await dispatcher.execute("editor.openFile", { path: target });
      return target;
    }
    const home = root ? null : ((await appIpc.info().catch(() => null))?.homeDir ?? null);
    const dir = root ?? home;
    const name = `${suggestedName(text, untitledName(from))}.txt`;
    const dest =
      (to && (root ? workspace.resolve(to) : to)) ??
      (await dialogIpc.pickSavePath("Save as", dir ? joinPath(dir, name) : name));
    if (!dest) throw new Error("Save cancelled.");
    if (root && !workspace.contains(dest))
      throw new Error(
        workspace.isMultiRoot()
          ? "Save inside one of the workspace's folders (files outside them aren't reachable)."
          : "Save inside the open folder (files outside it aren't reachable).",
      );
    if (!root && !(await workspace.open(dirname(dest)))) throw new Error("Save cancelled.");
    // The destination is already open as another document: adopting would create a second model
    // under its URI (disposing the open tab's model). Put the text into that document instead,
    // save it there (undo still reaches its old text) and close the untitled editor.
    const existing = editors.find(dest);
    if (existing && existing !== doc) {
      const target = existing.model.peek();
      if (existing.kind !== "text" || !target || target.readOnly || existing.notUtf8)
        throw new Error("That file is open in an editor that can't take text; close it first.");
      target.replaceText(text);
      await editors.save(existing);
      await dispatcher.execute("editor.openFile", { path: dest });
      // Emptied, the untitled document is clean, so its tab closes without asking.
      model.replaceText("");
      for (const tab of services.dock.tabs("editor"))
        if ((tab.viewState as { path?: string } | null)?.path === from)
          await services.dock.closeTab(tab.id, true);
      return dest;
    }
    await fsIpc.write(dest, new TextEncoder().encode(text));
    // Opening a folder may have replaced the tabs: the document lives on if its tab did.
    if (editors.find(from) === doc) editors.adopt(doc, dest);
    else await dispatcher.execute("editor.openFile", { path: dest });
    return dest;
  };
  editors.saveUntitled = async (doc) => void (await saveUntitled(doc));
  sub.add({ dispose: () => (editors.saveUntitled = undefined) });

  sub.add(
    dispatcher.register({
      id: "editor.saveUntitled",
      title: "Save untitled file as…",
      category: "File",
      description:
        "Saves an untitled editor (`untitled`, default: the active one) to `as` (asked when missing); its tab becomes that file.",
      input: s.object({
        untitled: s
          .string()
          .describe("untitled:Untitled-N (default: the active editor)")
          .optional(),
        as: s.string().describe("Destination file").optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      palette: false,
      run: async ({ untitled, as }) => {
        const tab = services.dock.activeTab();
        const active = (tab?.viewState as { path?: string } | null)?.path;
        const path = untitled ?? active;
        const doc = path && isUntitled(path) ? editors.find(path) : undefined;
        if (!doc) throw new Error("No untitled editor.");
        return { saved: await saveUntitled(doc, as) };
      },
    }),
  );
}
