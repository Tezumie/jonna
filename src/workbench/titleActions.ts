// Extensions' buttons on a tab's toolbar (`menus` "editor/title", D176): the text editor's tabs
// and, since D419, an extension's file viewers (VS Code's custom editors), where the item's
// `when` can test `activeCustomEditorId`.
import { matchesWhen } from "../core/context/index";
import { knownIcon } from "../ui/Icon";
import type { TabAction } from "./dock/views";
import { resourceContext } from "./extensionFeatures";
import type { WorkbenchServices } from "./services";

/** At most this many: the toolbar is shared with the IDE's own buttons. */
const MAX_TITLE_ACTIONS = 5;

/**
 * The "editor/title" items whose `when` holds for the tab showing `path`. `own` are the tab's
 * own context keys (its language, its custom editor's id), which win over the window's.
 */
export function contributedTitleActions(
  services: WorkbenchServices,
  path: string,
  own: Readonly<Record<string, string | boolean>> = {},
): TabAction[] {
  const keys: Record<string, string | boolean> = {
    ...resourceContext(
      path,
      false,
      typeof own.resourceLangId === "string" ? own.resourceLangId : undefined,
    ),
    ...own,
  };
  const dark = services.theme.theme.peek() === "dark";
  return services.extensionFeatures
    .menuItems("editor/title", (when) =>
      matchesWhen(when, (k: string) => (k in keys ? keys[k] : services.context.get(k))),
    )
    .slice(0, MAX_TITLE_ACTIONS)
    .map((m) => {
      // Its own image, the dark one with a dark theme (D262).
      const image = dark ? m.iconImageDark : m.iconImage;
      return {
        icon: knownIcon(m.icon, "circle-dot"),
        ...(image && { iconImage: image }),
        title: m.title,
        command: m.command,
        input: { path },
      };
    });
}
