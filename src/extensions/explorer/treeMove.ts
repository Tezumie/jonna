// Moving files by dragging rows inside the explorer tree: after a 4px move, the folder under the
// pointer (a file row means its folder; empty space means the root) becomes the drop target if
// it can take every dragged path; releasing there runs explorer.move. Hovering a collapsed folder
// for a moment expands it. Rows are found by geometry (a file drag also drives the dock's drag,
// which turns off pointer events everywhere).

import { on } from "../../core/dom/index";
import type { DirEntry } from "../../core/ipc/fs";
import { DisposableStore } from "../../core/lifecycle/index";
import { dirname, isWithin, pathKey } from "../../core/paths/index";
import type { Tree } from "../../ui/Tree";

export interface TreeMoveHost {
  root(): string | null;
  /** The pointer is over the folder's own row (drops go into the root). */
  isRootAt(x: number, y: number): boolean;
  /** Highlights the drop-target folder (null clears). */
  setTarget(dir: string | null): void;
  move(paths: string[], dest: string): void;
}

export function armTreeMove(
  scope: DisposableStore,
  tree: Tree<DirEntry>,
  down: PointerEvent,
  path: string,
  host: TreeMoveHost,
): void {
  const drag = new DisposableStore();
  scope.add(drag);
  let moving = false;
  let cancelled = false;
  const end = () => {
    host.setTarget(null);
    scope.delete(drag);
  };
  /** The selection if the drag started inside it, else just the dragged row. */
  const sources = () => {
    const selected = tree.selectedItems().map((e) => e.path);
    return selected.includes(path) ? selected : [path];
  };
  let hoverDir: string | null = null;
  let springTimer: ReturnType<typeof setTimeout> | undefined;
  drag.add({ dispose: () => clearTimeout(springTimer) });
  /** Expands a collapsed folder the pointer rests on (like VS Code, ~600 ms). */
  const spring = (entry: DirEntry | null | undefined) => {
    const dir = entry?.kind === "dir" && !tree.isExpanded(entry.path) ? entry.path : null;
    if (dir === hoverDir) return;
    hoverDir = dir;
    clearTimeout(springTimer);
    if (dir) springTimer = setTimeout(() => void tree.expand(dir), 600);
  };
  const targetAt = (x: number, y: number): string | null => {
    const over = tree.itemAtPoint(x, y);
    if (over === undefined && !host.isRootAt(x, y)) return null;
    const entry = over ?? null;
    const dir = entry ? (entry.kind === "dir" ? entry.path : dirname(entry.path)) : host.root();
    if (!dir) return null;
    const ok = sources().every((p) => !isWithin(p, dir) && pathKey(dirname(p)) !== pathKey(dir));
    return ok ? dir : null;
  };
  drag.add(
    on(window, "pointermove", (e) => {
      if (cancelled) return;
      if (!moving && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 4) return;
      moving = true;
      host.setTarget(targetAt(e.clientX, e.clientY));
      spring(tree.itemAtPoint(e.clientX, e.clientY));
    }),
  );
  drag.add(
    on(window, "pointerup", (e) => {
      const dest = moving && !cancelled ? targetAt(e.clientX, e.clientY) : null;
      end();
      if (dest) host.move(sources(), dest);
    }),
  );
  drag.add(on(window, "pointercancel", end));
  drag.add(
    on(
      window,
      "keydown",
      (e) => {
        if (e.key !== "Escape") return;
        cancelled = true; // the rest of this drag does nothing
        host.setTarget(null);
      },
      { capture: true },
    ),
  );
}
