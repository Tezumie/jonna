// The Markdown preview's find commands (D210): markdown.find / findNext / findPrevious /
// closeFind, run by its find bar's buttons and keys (Ctrl/Cmd+F, Enter, Shift+Enter, F3, Escape
// while the preview has focus) and by agents; `ide://markdownPreview` reports the search.
import type { Disposable } from "../../core/lifecycle/index";
import { samePath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { MarkdownPreview } from "./views";

export function registerPreviewFind(
  services: WorkbenchServices,
  resolve: (path: string) => string,
): Disposable[] {
  const { dock, dispatcher } = services;
  const out: Disposable[] = [];

  /** The preview a command is for: of `path`, else the active tab when it's a preview. */
  const target = (path?: string): MarkdownPreview => {
    if (path) {
      const full = resolve(path);
      const tab = dock
        .tabs("markdownPreview")
        .find((t) => samePath(String(stateField(t.viewState, "path") ?? ""), full));
      const view = tab ? dock.liveView(tab.id) : undefined;
      if (view instanceof MarkdownPreview) return view;
      throw new Error(`No Markdown preview of ${path} is open (viewer.openPreview opens one).`);
    }
    const tab = dock.activeTab();
    const view = tab ? dock.liveView(tab.id) : undefined;
    if (view instanceof MarkdownPreview) return view;
    throw new Error("The active tab isn't a Markdown preview.");
  };
  const pathInput = s
    .string()
    .describe("The previewed Markdown file (default: the active preview)")
    .optional();

  out.push(
    dispatcher.register({
      id: "markdown.find",
      title: "Find in preview",
      category: "Markdown",
      description:
        "Opens the Markdown preview's find bar (Ctrl/Cmd+F in the preview) and searches the rendered text; highlights every match, makes the first one from the reading position current and scrolls to it. Options left out keep their last value. Returns the match count, the current match (0-based) and its text.",
      input: s.object({
        path: pathInput,
        query: s.string().describe("Text (or pattern) to find").optional(),
        caseSensitive: s.boolean().optional(),
        wholeWord: s.boolean().optional(),
        regex: s.boolean().describe("`query` is a regular expression").optional(),
        focus: s.boolean().describe("Put the cursor in the find field (default true)").optional(),
      }),
      // The matches tell what the document says.
      effects: ["read"],
      agent: "discoverable",
      run: ({ path, focus, ...options }, ctx) => {
        const view = target(path);
        view.openFind({ ...options, focus: ctx.caller.kind === "user" && focus !== false });
        return view.find.info();
      },
    }),
  );
  for (const [id, title, direction] of [
    ["markdown.findNext", "Find next in preview", 1],
    ["markdown.findPrevious", "Find previous in preview", -1],
  ] as const)
    out.push(
      dispatcher.register({
        id,
        title,
        category: "Markdown",
        description: `Moves to the ${direction === 1 ? "next" : "previous"} match of the Markdown preview's find (wrapping around) and scrolls to it. Returns the match count, the current match and its text.`,
        input: s.object({ path: pathInput }),
        effects: ["read"],
        agent: "discoverable",
        run: ({ path }) => {
          const view = target(path);
          if (!view.find.isOpen) view.openFind({ focus: false });
          view.find.step(direction);
          return view.find.info();
        },
      }),
    );
  out.push(
    dispatcher.register({
      id: "markdown.closeFind",
      title: "Close find in preview",
      category: "Markdown",
      description: "Closes the Markdown preview's find bar and clears its highlights.",
      input: s.object({ path: pathInput }),
      effects: [],
      agent: "hidden",
      run: ({ path }) => {
        const view = target(path);
        view.closeFind();
        return { open: false };
      },
    }),
  );

  out.push(
    services.state.register("ide://markdownPreview", {
      description:
        "The active Markdown preview: its file and its find bar's search (open, query, options, match count, current match and its text).",
      get: () => {
        const tab = dock.activeTab();
        const view = tab ? dock.liveView(tab.id) : undefined;
        if (!(view instanceof MarkdownPreview)) return { active: null };
        return { active: { path: view.file, find: { ...view.find.info() } } };
      },
    }),
  );
  return out;
}
