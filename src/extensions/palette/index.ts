// Built-in Command Palette (Ctrl/Cmd+Shift+P, F1): quick access with ">" typed in, so commands
// are listed (recently used first) and deleting ">" searches files instead, as in VS Code (D133).
// Commands that need input ask for each required field before running.
import type { BuiltinExtension } from "../../core/extensions/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import manifest from "./extension.json";

export const paletteExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    sub.add(
      services.dispatcher.register({
        id: "palette.show",
        title: "Show all commands",
        category: "View",
        description:
          "Opens the command palette: quick access with '>' (fuzzy search over all commands).",
        input: s.empty(),
        effects: [],
        agent: "hidden",
        run: (_input, ctx) => ctx.execute("quickOpen.show", { query: ">" }),
      }),
    );
  },
};
