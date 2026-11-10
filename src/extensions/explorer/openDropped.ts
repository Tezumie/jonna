// Files dropped onto the window from the OS, anywhere but the explorer's folders or a part that
// takes drops itself (the terminal, the agent's chat), open as in VS Code (D281): files in an
// editor of the group under the pointer (from any folder: the user's own choice, D190), a folder
// as the workspace when none is open, else added beside it or opened in its place.

import { dragDropIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";

export function registerOpenDropped(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, quickInput, workspace } = services;
  sub.add(
    dispatcher.register({
      id: "explorer.openDropped",
      title: "Open dropped files",
      category: "File",
      description:
        "Opens what was last dropped onto the window from the OS: files in an editor (in the group at x, y when given), a folder as the workspace when none is open, else added to the workspace or opened in its place (the user picks).",
      input: s.object({
        x: s.number().optional(),
        y: s.number().optional(),
      }),
      effects: [],
      agent: "hidden",
      palette: false,
      run: async ({ x, y }, ctx) => {
        const entries = await dragDropIpc.droppedEntries();
        const files = entries.filter((e) => !e.dir).map((e) => e.path);
        const folders = entries.filter((e) => e.dir).map((e) => e.path);
        // The group under the pointer gets the files, as in VS Code.
        const at = x !== undefined && y !== undefined ? document.elementFromPoint(x, y) : null;
        const groupId = at?.closest<HTMLElement>("[data-group-id]")?.dataset.groupId;
        if (files.length && groupId)
          await ctx.execute("layout.focusGroup", { groupId, focusView: false }).catch(() => {});
        for (const path of files)
          await ctx.execute("editor.openFile", { path, preview: false }).catch(() => {});
        if (!folders.length) return { opened: files, folders: [] };
        if (!workspace.root.peek()) {
          await ctx.execute("workspace.openFolder", { path: folders[0] });
          return { opened: files, folders: folders.slice(0, 1) };
        }
        const names = folders.map((f) => basename(f)).join(", ");
        const picked = await quickInput.pick(
          [
            { id: "add", label: "Add to workspace", description: names },
            ...(folders.length === 1
              ? [{ id: "open", label: "Open folder", description: "In place of this one" }]
              : []),
          ],
          { placeholder: `Dropped ${folders.length === 1 ? "a folder" : "folders"}` },
        );
        if (picked?.id === "add") await ctx.execute("workspace.addFolder", { paths: folders });
        else if (picked?.id === "open")
          await ctx.execute("workspace.openFolder", { path: folders[0] });
        return { opened: files, folders: picked ? folders : [] };
      },
    }),
  );
}
