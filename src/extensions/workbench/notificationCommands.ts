// The notifications bell (rightmost in the status bar, like VS Code): unread count, the list of
// recent notifications with their actions, clear, and do not disturb. Also `ide://notifications`.
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { MenuItem } from "../../ui/Menu";
import { showMenu } from "../../ui/Menu";
import type { WorkbenchServices } from "../../workbench/services";

const ICON = {
  info: "info",
  success: "circle-check",
  warning: "triangle-alert",
  error: "circle-alert",
} as const;

function ago(time: number): string {
  const s = Math.round((Date.now() - time) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export function registerNotificationCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
): void {
  const { dispatcher, notifications, statusBar } = services;
  const register: typeof dispatcher.register = (command) =>
    sub.add(dispatcher.register({ category: "Notifications", ...command }));

  register({
    id: "notifications.show",
    title: "Show notifications",
    description:
      "Opens the list of recent notifications (from the status bar bell) and marks them read.",
    input: s.empty(),
    effects: [],
    run: () => {
      const anchor = document.querySelector<HTMLElement>(
        '.statusbar-item[data-id="notifications"]',
      ) ?? { x: window.innerWidth - 16, y: window.innerHeight - 24 };
      const list = notifications.history.peek();
      const items: MenuItem[] = list.slice(0, 20).map((n) => ({
        label:
          `${n.title ? `${n.title}: ` : ""}${n.message}`.slice(0, 120) +
          (n.count && n.count > 1 ? ` (×${n.count})` : ""),
        icon: ICON[n.kind],
        keybinding: ago(n.time),
        ...(n.actions.length
          ? { submenu: n.actions.map((a) => ({ label: a.label, run: () => a.run() })) }
          : {}),
      }));
      if (!items.length) items.push({ label: "No new notifications", disabled: true });
      items.push(
        {
          label: "Do not disturb",
          checked: notifications.doNotDisturb.peek(),
          separatorBefore: true,
          run: () => void dispatcher.execute("notifications.toggleDoNotDisturb").catch(() => {}),
        },
        {
          label: "Clear all notifications",
          icon: "ban",
          disabled: list.length === 0,
          run: () => void dispatcher.execute("notifications.clear").catch(() => {}),
        },
      );
      notifications.markRead();
      // The pop-ups are all in the list; they'd cover it.
      notifications.dismissAll();
      sub.add(showMenu(anchor, items, "Notifications"));
    },
  });
  register({
    id: "notifications.clear",
    title: "Clear all notifications",
    description: "Dismisses the visible notifications and empties the list.",
    input: s.empty(),
    effects: [],
    run: () => {
      notifications.dismissAll();
      notifications.clearHistory();
    },
  });
  register({
    id: "notifications.toggleDoNotDisturb",
    title: "Toggle do not disturb",
    description:
      "With do not disturb on, only errors show as pop-ups; everything else goes to the list.",
    input: s.empty(),
    effects: [],
    run: () => {
      notifications.doNotDisturb.value = !notifications.doNotDisturb.peek();
      return { doNotDisturb: notifications.doNotDisturb.peek() };
    },
  });
  register({
    id: "notifications.resetHidden",
    title: "Show hidden notices again",
    description:
      'Brings back every notice turned off with "Don\'t show again" (they show again the next time they apply).',
    input: s.empty(),
    effects: ["write"],
    run: async () => {
      const count = services.persistence.globalState().hiddenNotices?.length ?? 0;
      await services.persistence.saveGlobal({ hiddenNotices: [] });
      return { shownAgain: count };
    },
  });
  sub.add(
    services.state.register("ide://notifications", {
      description: "Recent notifications (newest first), unread count and do not disturb.",
      get: () => ({
        doNotDisturb: notifications.doNotDisturb.peek(),
        unread: notifications.unread.peek(),
        hiddenNotices: services.persistence.globalState().hiddenNotices ?? [],
        items: notifications.history.peek().map((n) => ({
          kind: n.kind,
          title: n.title ?? null,
          message: n.message,
          time: new Date(n.time).toISOString(),
          actions: n.actions.map((a) => a.label),
        })),
      }),
    }),
  );
  sub.add(
    statusBar.add({
      id: "notifications",
      name: "Notifications",
      alignment: "right",
      priority: 1000,
      text: () => {
        const unread = notifications.unread.value;
        return unread ? `$(bell-dot) ${unread}` : "$(bell)";
      },
      tooltip: () => {
        const unread = notifications.unread.value;
        const dnd = notifications.doNotDisturb.value ? " (do not disturb)" : "";
        return unread
          ? `${unread} new notification${unread === 1 ? "" : "s"}${dnd}`
          : `No new notifications${dnd}`;
      },
      command: "notifications.show",
    }),
  );
}
