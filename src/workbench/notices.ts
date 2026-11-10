// Notices the user can turn off for good (D344), as VS Code's "Don't Show Again" (its
// neverShowAgain storage): an informational notice that would otherwise come back on every start
// gets the button, and the choice is kept for every window (the global state). Hidden notices come
// back with notifications.resetHidden ("Show hidden notices again").
import type { NotificationKind, NotificationOptions } from "../ui/Notifications";
import type { WorkbenchServices } from "./services";

/** Whether the user hid the notice `key` ("Don't show again"). */
export function isNoticeHidden(services: WorkbenchServices, key: string): boolean {
  return services.persistence.globalState().hiddenNotices?.includes(key) ?? false;
}

/**
 * Shows a notice with a "Don't show again" button, unless it was hidden before. `key` names the
 * notice (stable across versions, e.g. "lsp.yield.pyright.ms-python.python").
 */
export function showDismissible(
  services: WorkbenchServices,
  key: string,
  kind: NotificationKind,
  message: string,
  options: NotificationOptions = {},
): void {
  if (isNoticeHidden(services, key)) return;
  services.notifications.show(kind, message, {
    ...options,
    actions: [
      ...(options.actions ?? []),
      {
        label: "Don't show again",
        run: () =>
          void services.persistence.saveGlobal((g) => ({
            hiddenNotices: [...new Set([...(g.hiddenNotices ?? []), key])].slice(-200),
          })),
      },
    ],
  });
}
