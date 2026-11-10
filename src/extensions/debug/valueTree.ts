// The trees of values in "Run and debug" (D143, D145): Variables (the selected frame's scopes)
// and Watch (the watch expressions). Objects expand lazily; double-click (or F2) a variable to
// change it; the context menu copies, edits or removes.
import { h, on, replaceChildren } from "../../core/dom/index";
import type { DisposableStore } from "../../core/lifecycle/index";
import { showContextMenu } from "../../ui/Menu";
import { Tree } from "../../ui/Tree";
import type { DebugController } from "./controller";
import type { Variable } from "./session";
import type { WatchValue } from "./watches";

export type ValueNode =
  | { kind: "root" }
  | { kind: "scope"; name: string; ref: number; expensive: boolean; id: string }
  | { kind: "watch"; expression: string; result: WatchValue | null; id: string }
  /** `container`: the scope's or object's ref this variable belongs to (to change it). */
  | { kind: "var"; v: Variable; container: number; id: string };

export function valueTree(
  host: HTMLElement,
  store: DisposableStore,
  debug: DebugController,
  roots: () => ValueNode[],
  label: string,
  run: (command: string, input?: unknown) => void,
): Tree<ValueNode> {
  const refOf = (n: ValueNode) =>
    n.kind === "scope"
      ? n.ref
      : n.kind === "var"
        ? n.v.ref
        : n.kind === "watch"
          ? (n.result?.ref ?? 0)
          : 0;
  const tree = store.add(
    new Tree<ValueNode>(
      host,
      {
        id: (n) => (n.kind === "root" ? "" : n.id),
        hasChildren: (n) => n.kind === "root" || refOf(n) > 0,
        children: async (n) => {
          if (n.kind === "root") return roots();
          const ref = refOf(n);
          const session = debug.active;
          if (!ref || !session) return [];
          const vars = await session.variables(ref).catch(() => []);
          return vars.map((v) => ({
            kind: "var" as const,
            v,
            container: ref,
            id: `${n.id}/${v.name}`,
          }));
        },
      },
      {
        render: (n, row) => {
          if (n.kind === "scope") replaceChildren(row, h("span", { class: "debug-scope" }, n.name));
          else if (n.kind === "var")
            replaceChildren(
              row,
              h("span", { class: "debug-var-name" }, n.v.name),
              h("span", { class: "debug-var-sep" }, ": "),
              h("span", { class: `debug-var-value is-${n.v.type ?? "other"}` }, n.v.value),
            );
          else if (n.kind === "watch")
            replaceChildren(
              row,
              h("span", { class: "debug-var-name" }, n.expression),
              h("span", { class: "debug-var-sep" }, ": "),
              h(
                "span",
                {
                  class: `debug-var-value${n.result?.error ? " is-error" : n.result ? "" : " is-unavailable"}`,
                },
                n.result?.value ?? "not available",
              ),
            );
        },
      },
      { rowHeight: 22, ariaLabel: label },
    ),
  );
  const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});
  const edit = (n: ValueNode | null | undefined) => {
    if (n?.kind === "var")
      run("debug.setVariable", { container: n.container, name: n.v.name, current: n.v.value });
    else if (n?.kind === "watch") run("debug.editWatch", { expression: n.expression });
  };
  store.add(on(tree.element, "dblclick", (e) => edit(tree.itemAt(e.target as Element))));
  store.add(
    on(tree.element, "keydown", (e) => {
      if (e.key !== "F2") return;
      e.preventDefault();
      edit(tree.selectedItems()[0]);
    }),
  );
  store.add(
    tree.onContextMenu(({ item, x, y }) => {
      if (item?.kind === "var")
        store.add(
          showContextMenu(x, y, [
            { label: "Set value…", icon: "pencil", keybinding: "F2", run: () => edit(item) },
            { label: "Copy value", icon: "copy", run: () => copy(item.v.value) },
            { label: "Copy as expression", icon: "copy", run: () => copy(item.v.name) },
            {
              label: "Add to watch",
              icon: "eye",
              run: () => run("debug.addWatch", { expression: item.v.name }),
            },
            // Data breakpoints (D204): only where the debugger has them.
            ...(debug.focused.peek()?.capabilities.peek().dataBreakpoints
              ? [
                  {
                    label: "Break on value change",
                    icon: "circle-dot" as const,
                    separatorBefore: true,
                    run: () =>
                      run("debug.addDataBreakpoint", {
                        container: item.container,
                        name: item.v.name,
                      }),
                  },
                ]
              : []),
          ]),
        );
      else if (item?.kind === "watch")
        store.add(
          showContextMenu(x, y, [
            { label: "Edit expression…", icon: "pencil", keybinding: "F2", run: () => edit(item) },
            { label: "Copy value", icon: "copy", run: () => copy(item.result?.value ?? "") },
            {
              label: "Remove expression",
              icon: "trash-2",
              separatorBefore: true,
              run: () => run("debug.removeWatch", { expression: item.expression }),
            },
          ]),
        );
    }),
  );
  return tree;
}
