// editor.resolveConflict (D120): keeps the current side, the incoming side or both of the merge
// conflict at a line (or every conflict in the file) — the code lenses above `<<<<<<<` and agents
// use it. One undoable edit; the file isn't saved.
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { conflictAt, findConflicts, resolveConflicts } from "./conflicts";
import type { EditorService } from "./service";

export function registerConflictCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  editors: EditorService,
  activePath: () => string | undefined,
): void {
  sub.add(
    services.dispatcher.register({
      id: "editor.resolveConflict",
      title: "Resolve merge conflict",
      category: "Git",
      description:
        "Resolves a merge conflict (<<<<<<< … >>>>>>>) in an open file by keeping the current side, the incoming side or both: the conflict at `line` (or the next one after it), or every conflict with `all`. One undoable edit; save to keep it.",
      input: s.object({
        path: s.string().describe("File (default: the active editor)").optional(),
        line: s.integer({ min: 1 }).describe("A line in or before the conflict").optional(),
        choice: s.enum(["current", "incoming", "both"] as const),
        all: s.boolean().describe("Every conflict in the file").optional(),
      }),
      effects: ["write"],
      agent: "discoverable",
      run: async ({ path, line, choice, all }) => {
        const target = path ? services.workspace.resolve(path) : activePath();
        if (!target) throw new Error("No file to resolve.");
        await services.dispatcher.execute("editor.openFile", { path: target, preserveFocus: true });
        const model = editors.find(target)?.model.peek();
        if (!model) throw new Error("The file isn't open in an editor yet.");
        const text = model.getText();
        const conflicts = findConflicts(text);
        if (!conflicts.length) return { resolved: 0, remaining: 0 };
        const one = all ? "all" : conflictAt(conflicts, line ?? 1);
        if (!one) return { resolved: 0, remaining: conflicts.length };
        const next = resolveConflicts(text, choice, one);
        model.replaceText(next.text);
        return { resolved: next.resolved, remaining: findConflicts(next.text).length };
      },
    }),
  );
}
