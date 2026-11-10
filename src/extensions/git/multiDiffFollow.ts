// Source control's changes tabs follow the repository's status (VS Code's multi-diff editor): an
// open "Changes" / "Staged changes" tab (git.viewChanges / git.viewStagedChanges) is listed
// again when the status changes (debounced), through editor.openMultiDiff's `background`, which
// updates the tab without activating it or taking the focus and keeps the file at the top of
// the view, folds, unsaved edits and the caret (editor/multiDiffView.ts). A tab not created yet
// (restored, never shown) is brought up to date once it is: the dock's change schedules this
// again. Next / previous file are the editor's (editor.multiDiff.nextFile / previousFile).

import type { Json, TabRef } from "../../core/dock/index";
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { changesSource, changesTabInput } from "./changesTab";
import type { GitRepositories } from "./repositories";

const VIEW_TYPE = "multiDiff";
/** How long the status must settle before the tabs are listed again. */
const FOLLOW_DELAY = 300;

/** The `source` a multi-file diff tab shows, from its state. */
function sourceOf(state: Json): string | null {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
  return typeof state.source === "string" ? state.source : null;
}

/** Which of the repositories' changes tabs (`roots`, unstaged then staged) are open. */
export function followedChanges(
  openSources: ReadonlySet<string>,
  roots: readonly string[],
): { root: string; staged: boolean }[] {
  const out: { root: string; staged: boolean }[] = [];
  for (const root of roots)
    for (const staged of [false, true])
      if (openSources.has(changesSource(root, staged))) out.push({ root, staged });
  return out;
}

export function registerMultiDiffFollow(
  sub: DisposableStore,
  services: WorkbenchServices,
  repos: GitRepositories,
): void {
  const { dock, dispatcher } = services;
  let timer: ReturnType<typeof setTimeout> | undefined;
  sub.add({ dispose: () => clearTimeout(timer) });

  const follow = () => {
    const tabs: TabRef[] = dock.tabs(VIEW_TYPE);
    if (!tabs.length) return;
    const open = new Set<string>();
    for (const tab of tabs) {
      const source = sourceOf(dock.liveView(tab.id)?.serialize() ?? tab.viewState);
      if (source) open.add(source);
    }
    const all = repos.all.peek();
    const byRoot = new Map(
      all.flatMap((git) => {
        const root = git.repo.peek()?.root;
        return root ? [[root, git] as const] : [];
      }),
    );
    for (const { root, staged } of followedChanges(open, [...byRoot.keys()])) {
      const git = byRoot.get(root);
      if (!git) continue;
      const input = changesTabInput(git, root, staged, all.length > 1);
      void dispatcher
        .execute("editor.openMultiDiff", { ...input, background: true })
        .catch(() => {});
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(follow, FOLLOW_DELAY);
  };
  sub.add(
    effect(() => {
      for (const git of repos.all.value) git.groups.value;
      // Tabs opened, shown or restored.
      dock.root.value;
      schedule();
      return undefined;
    }),
  );
}
