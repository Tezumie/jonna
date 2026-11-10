// "Loaded scripts" (D204), VS Code's section of Run and debug: the scripts the focused session
// has loaded (Node's and pages' parsed scripts, a DAP adapter's `loadedSources`), the project's
// first, by path; a click opens one. Folded by default and loaded when opened; it refreshes at
// each stop and when the focused session changes. Shown only for debuggers that can list them.
import { h, on, replaceChildren } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type { WorkbenchServices } from "../../workbench/services";
import type { DebugController } from "./controller";
import type { LoadedSource } from "./session";

export function loadedScriptsSection(
  store: DisposableStore,
  services: WorkbenchServices,
  debug: DebugController,
  run: (command: string, input?: unknown) => void,
): HTMLElement {
  const chevron = h("span", { class: "debug-section-chevron" }, icon("chevron-right"));
  const title = h(
    "button",
    { class: "debug-section-title debug-section-toggle", type: "button", "aria-expanded": "false" },
    chevron,
    h("span", {}, "Loaded scripts"),
  );
  const filter = h("input", {
    class: "input debug-loaded-filter",
    type: "search",
    placeholder: "Filter",
    "aria-label": "Filter loaded scripts",
  });
  const list = h("div", { class: "debug-list debug-loaded", role: "list" });
  const body = h("div", { class: "debug-loaded-body" }, filter, list);
  body.hidden = true;
  const section = h("section", { class: "debug-section debug-loaded-section" }, title, body);
  section.hidden = true;
  const rows = store.add(new DisposableStore());
  let open = false;
  let items: LoadedSource[] = [];
  let loading = 0;

  const draw = () => {
    rows.clear();
    const { workspace } = services;
    const q = filter.value.trim().toLowerCase();
    const shown = items
      .map((s) => ({
        s,
        // Any folder of the workspace is the user's own code (D251).
        label: s.path ? workspace.relative(s.path) : (s.origin ?? s.name),
        own: !!(s.path && workspace.contains(s.path) && !/[\\/]node_modules[\\/]/.test(s.path)),
      }))
      .filter((x) => !q || x.label.toLowerCase().includes(q))
      .sort((a, b) => Number(b.own) - Number(a.own) || a.label.localeCompare(b.label))
      .slice(0, 500);
    replaceChildren(
      list,
      ...(shown.length
        ? shown.map(({ s, label, own }) => {
            const row = h(
              "button",
              {
                class: `debug-row${own ? "" : " is-internal"}`,
                type: "button",
                role: "listitem",
                disabled: !s.path,
              },
              h("span", { class: "debug-row-main" }, s.name),
              h("span", { class: "debug-row-detail" }, label),
            );
            setTooltip(row, label);
            if (s.path) rows.add(on(row, "click", () => run("editor.openFile", { path: s.path })));
            return row;
          })
        : [
            h("div", { class: "debug-empty" }, items.length ? "No match" : "No scripts loaded yet"),
          ]),
    );
  };

  const load = async () => {
    const mine = ++loading;
    const session = debug.active;
    const list = (await session?.loadedSources?.().catch(() => [])) ?? [];
    if (mine !== loading) return;
    items = list;
    draw();
  };

  store.add(
    on(title, "click", () => {
      open = !open;
      body.hidden = !open;
      title.setAttribute("aria-expanded", String(open));
      chevron.classList.toggle("is-open", open);
      if (open) void load();
    }),
  );
  store.add(on(filter, "input", draw));
  store.add(
    effect(() => {
      const rs = debug.focused.value;
      const can = rs?.capabilities.value.loadedSources === true;
      rs?.state.value;
      section.hidden = !can;
      if (can && open) void load();
      return undefined;
    }),
  );
  return section;
}
