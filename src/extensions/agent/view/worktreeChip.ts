// The branch a chat works on in the header (D337), when it entered a git worktree
// (enter_worktree): a quiet chip with the branch; clicking it offers review, merge and leave
// (agent.chatWorktree). Hidden for any other chat.

import { h, on } from "../../../core/dom/index";
import { type Disposable, DisposableStore } from "../../../core/lifecycle/index";
import { effect } from "../../../core/reactive/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import { chatWorktrees } from "../chatWorktrees";

export class WorktreeChip implements Disposable {
  readonly element: HTMLButtonElement;
  private readonly store = new DisposableStore();

  constructor(session: string, run: (command: string, input?: unknown) => void) {
    const label = h("span", { class: "agent-worktree-chip-label" });
    this.element = h(
      "button",
      { class: "agent-worktree-chip", type: "button", hidden: true },
      icon("git-branch"),
      label,
    ) as HTMLButtonElement;
    this.store.add(on(this.element, "click", () => run("agent.chatWorktree", { session })));
    let shown = "";
    this.store.add(
      effect(() => {
        const w = chatWorktrees.value.get(session);
        this.element.hidden = !w;
        const key = w ? `${w.branch}\n${w.folder}` : "";
        if (key === shown) return undefined;
        shown = key;
        if (w) {
          label.textContent = w.branch;
          this.element.setAttribute("aria-label", `Worktree ${w.branch}`);
          setTooltip(
            this.element,
            `This chat works in ${w.folder} (branch ${w.branch}), not the open folder. Review, merge or leave it`,
          );
        }
        return undefined;
      }),
    );
  }

  dispose(): void {
    this.store.dispose();
  }
}
