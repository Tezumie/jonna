// Terminals an extension makes (D233, `ide.terminals.create`): the tab's state names either its
// pseudoterminal (`pseudo`: a key of core/ipc/virtualPty.ts, served by the extension) or the
// shell it chose (`shell`: { path, args }). Neither is saved with the tab (pane.serialize leaves
// them out): after a restart the tab is an ordinary shell, as a task's is. One made with
// hideFromUser or isTransient (D388) carries `transient`: hidden or not, it isn't saved at all.
// DOM-free and tested.
import type { Json } from "../../core/dock/index";
import { stateField } from "../../workbench/dock/views";
import type { TerminalStart } from "./service";

/** How an extension's terminal starts, or null when the state isn't one. */
export function extensionTerminalStart(state: Json): TerminalStart | null {
  const name = stateField(state, "name");
  const title = typeof name === "string" && name ? { title: name } : {};
  const pseudo = stateField(state, "pseudo");
  if (typeof pseudo === "string" && pseudo)
    return { profile: { path: [], virtual: pseudo }, ...title };
  const shell = stateField(state, "shell");
  if (shell && typeof shell === "object" && !Array.isArray(shell)) {
    const path = (shell as Record<string, Json>).path;
    const args = (shell as Record<string, Json>).args;
    if (typeof path === "string" && path)
      return {
        profile: {
          path: [path],
          ...(Array.isArray(args) && {
            args: args.filter((a): a is string => typeof a === "string"),
          }),
        },
        ...title,
      };
  }
  return null;
}
