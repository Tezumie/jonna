// Code blocks in chat answers (D122): "Apply" puts a block into the file its fence names as a
// pending change to review (core/agent/applyCode.ts finds where it goes; auto-apply mode accepts
// it), "Insert" types it at the editor's cursor.
import { applySnippet, fencePath } from "../../core/agent/applyCode";
import { h } from "../../core/dom/index";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import { icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type { WorkbenchServices } from "../../workbench/services";
import type { SessionManager } from "./sessions";

export function registerCodeBlockCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  const { dispatcher, workspace } = services;
  sub.add(
    dispatcher.register({
      id: "agent.applyCode",
      title: "Apply code block to its file",
      category: "Agent",
      description:
        "Puts `code` into `path` as a pending agent change to review: the whole file when it is new or the block is most of it, else the lines between the block's first and last lines. Fails when it can't tell where the block goes.",
      input: s.object({
        session: s.string().describe("Session id (default: the active session)").optional(),
        path: s.string().describe("File (absolute or workspace-relative)"),
        code: s.string().describe("The code block's text"),
      }),
      effects: ["write"],
      agent: "hidden",
      when: "workspaceOpen",
      run: async ({ session, path, code }, ctx) => {
        const root = workspace.root.peek();
        if (!root) throw new Error("Open a folder first.");
        const sess = sessions.require(session);
        const abs = workspace.resolve(path);
        const original = await sess.changeset.current(abs);
        const result = applySnippet(original, code);
        if (!result)
          throw new Error(
            `Couldn't tell where this block goes in ${workspace.relative(abs)}. Ask the agent to apply it, or copy it in.`,
          );
        await sess.changeset.propose(abs, result.text, sess.turn);
        if (sess.autoApply.peek()) await sess.changeset.accept([abs]);
        else await ctx.execute("agent.openReviewDiff", { path: abs, session: sess.id });
        return {
          path: workspace.relative(abs),
          how: result.how,
          ...(result.from !== undefined && { from: result.from, to: result.to }),
          pending: !sess.autoApply.peek(),
        };
      },
    }),
  );
}

/** The Apply / Insert buttons of a finished code block in an answer. */
export function codeBlockActions(
  run: (command: string, input?: unknown) => void,
  session: string,
  block: { text: string; info: string; closed: boolean },
): Node[] {
  if (!block.closed || !block.text.trim()) return [];
  const out: Node[] = [];
  const path = fencePath(block.info);
  if (path) {
    const apply = h(
      "button",
      { class: "md-pre-action", type: "button" },
      icon("file-diff"),
      h("span", null, "Apply"),
    );
    setTooltip(apply, `Apply to ${path} (as a change to review)`);
    apply.addEventListener("click", () =>
      run("agent.applyCode", { session, path, code: shownCode(apply, block.text) }),
    );
    out.push(apply);
  }
  const insert = h(
    "button",
    { class: "icon-button md-copy", type: "button", "aria-label": "Insert at cursor" },
    icon("arrow-down"),
  );
  setTooltip(insert, "Insert at the cursor");
  insert.addEventListener("click", () =>
    run("editor.insertText", { text: shownCode(insert, block.text) }),
  );
  out.push(insert);
  return out;
}

/**
 * The code of the block the button sits in, read at click time as Copy does: the chat updates
 * in place, and a header kept from an earlier render would otherwise act on that render's code.
 */
function shownCode(button: HTMLElement, fallback: string): string {
  return button.closest(".md-pre")?.querySelector("code")?.textContent ?? fallback;
}
