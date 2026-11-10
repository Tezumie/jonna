// The debug console's session picker (D209, VS Code's): `debug.selectConsole` shows one session's
// console (and focuses that session while it runs, as VS Code does); without `session` it opens
// the list at `x` / `y` (the console's picker button) or as a quick pick.
import { s } from "../../core/schema/index";
import { showContextMenu } from "../../ui/Menu";
import type { WorkbenchServices } from "../../workbench/services";
import type { ConsoleChoice } from "./consoleSessions";
import type { DebugController } from "./controller";

type Register = WorkbenchServices["dispatcher"]["register"];

/** The picker's label for a console: its name, a compound's name after it, "(ended)". */
export function consoleLabel(c: ConsoleChoice): string {
  return `${c.name}${c.live ? "" : " (ended)"}`;
}

export function registerConsolePicker(
  register: Register,
  services: WorkbenchServices,
  debug: DebugController,
): void {
  const choices = () => debug.consoleList();
  const select = (id: string) => {
    const all = choices();
    const wanted =
      all.find((c) => c.id === id) ??
      all.find((c) => c.name === id) ??
      all.find((c) => c.name.startsWith(id));
    if (!wanted) throw new Error(`No debug console for “${id}”. See ide://debug consoles.`);
    // A running session's console: focus the session too (the toolbar and Variables follow).
    if (wanted.live) debug.focus(wanted.id);
    debug.consoles.selected.value = wanted.id;
    return wanted;
  };
  register({
    id: "debug.selectConsole",
    title: "Select debug console…",
    description:
      "Shows one debug session's console (each session — each of a compound's — has its own; a Node program's child processes write into their parent's). `session`: an id or name from ide://debug `consoles`; without it, asks which. A running session is focused too.",
    input: s.object({
      session: s.string().describe("Session id or name").optional(),
      x: s.number().optional(),
      y: s.number().optional(),
    }),
    effects: [],
    run: async ({ session, x, y }) => {
      if (session !== undefined) {
        const c = select(session);
        return { console: c.id, name: c.name };
      }
      const all = choices();
      if (!all.length) throw new Error("No debug session has written to the console yet.");
      const current = debug.consoles.selected.peek();
      if (x !== undefined && y !== undefined) {
        showContextMenu(
          x,
          y,
          all.map((c) => ({
            label: `${"  ".repeat(c.depth)}${consoleLabel(c)}`,
            ...(c.id === current && { icon: "check" as const }),
            ...(c.compound && { keybinding: c.compound }),
            run: () => {
              select(c.id);
            },
          })),
        );
        return { consoles: all.length };
      }
      const picked = await services.quickInput.pick(
        all.map((c) => ({
          id: c.id,
          label: consoleLabel(c),
          description: c.compound ?? "",
          icon: c.id === current ? ("check" as const) : ("bug-play" as const),
        })),
        { placeholder: "Select a debug console" },
      );
      if (!picked) return { console: current };
      const c = select(picked.id);
      return { console: c.id, name: c.name };
    },
  });
}
