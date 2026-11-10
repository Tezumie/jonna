// The status bar's settings and commands: hiding the whole bar (workbench.statusBar.visible,
// D179) and single items from its right-click menu (workbench.statusBar.hidden, D383), and
// `ide://statusbar`.
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { readHiddenItems, statusMenuEntries, withItemHidden } from "../../workbench/statusItems";

const VISIBLE = "workbench.statusBar.visible";
const HIDDEN = "workbench.statusBar.hidden";

export function registerStatusBarCommands(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, settings, statusBar, state } = services;
  sub.add(
    effect(() => {
      settings.version.value;
      const hidden = settings.peek<boolean>(VISIBLE) === false;
      statusBar.element.hidden = hidden;
      statusBar.element.parentElement?.classList.toggle("is-statusbar-hidden", hidden);
      statusBar.hidden.value = readHiddenItems(settings.peek<unknown>(HIDDEN));
      return undefined;
    }),
  );
  sub.add(
    dispatcher.register({
      id: "workbench.toggleStatusBar",
      title: "Toggle status bar",
      category: "View",
      description: "Shows or hides the status bar at the bottom of the window.",
      input: s.empty(),
      effects: ["write"],
      run: async () => {
        const visible = settings.peek<boolean>(VISIBLE) !== false;
        // The scope whose value shows now (a folder's settings can hide it too).
        const scope =
          settings.model.inspect(VISIBLE, "workspace") !== undefined ? "workspace" : "user";
        await settings.update(VISIBLE, !visible, scope);
        return { visible: !visible };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "statusBar.setItemHidden",
      title: "Hide or show a status bar item",
      description:
        "Hides (or shows again) one status bar item by its id (as listed in ide://statusbar); `all` with hidden: false shows every item. Stored in workbench.statusBar.hidden, for every folder.",
      input: s.object({
        id: s.string().describe("The item's id, from ide://statusbar").optional(),
        all: s.boolean().optional(),
        hidden: s.boolean(),
      }),
      effects: ["write"],
      palette: false,
      run: async ({ id, all, hidden }) => {
        if (!all && !id) throw new Error("Give an item's id, or all: true.");
        const next = withItemHidden(statusBar.hidden.peek(), all ? null : (id ?? null), hidden);
        await settings.update(HIDDEN, next, "user");
        return { hidden: next };
      },
    }),
  );
  sub.add(
    state.register("ide://statusbar", {
      description:
        "The status bar: whether it's shown, and its items in their order on the bar (id, name, what it shows now, whether the user hid it). Hide one with statusBar.setItemHidden.",
      get: () => {
        const items = statusBar.items.peek();
        const hidden = statusBar.hidden.peek();
        const texts = new Map<string, string>();
        for (const item of items) if (!texts.get(item.id)) texts.set(item.id, item.text());
        return {
          visible: settings.peek<boolean>(VISIBLE) !== false,
          items: statusMenuEntries(
            items.map((item) => ({ ...item, showing: (texts.get(item.id) ?? "") !== "" })),
          ).map((entry) => ({
            id: entry.id,
            name: entry.label,
            side: entry.alignment,
            text: texts.get(entry.id) ?? "",
            hidden: hidden.has(entry.id),
          })),
        };
      },
    }),
  );
}
