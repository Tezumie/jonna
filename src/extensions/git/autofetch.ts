// git.autofetch (D200, VS Code's): fetch every git.autofetchPeriod seconds while a repository with
// a remote is open, so the behind count stays current. Every repository of the folder (nested ones
// and submodules too, D207 — VS Code fetches each), one after another. Quiet: no notification,
// and a repository whose fetch failed (a sign-in it couldn't answer) is skipped until a fetch,
// pull or push of your own in it.

import type { DisposableStore } from "../../core/lifecycle/index";
import { effect, type ReadonlySignal } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { GitRepo } from "./controller";

/**
 * Whether a settings change restarts the autofetch timer (D220): only its own two settings —
 * any other change (a theme, a font size) used to restart it, so a user changing settings
 * often pushed the next fetch back again and again.
 */
export function restartsAutofetch(keys: readonly string[]): boolean {
  return keys.some((k) => k === "git.autofetch" || k === "git.autofetchPeriod");
}

/** Seconds between fetches (VS Code's default is 180; never less than 30). */
export function autofetchPeriod(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(30, value) : 180;
}

export function registerAutofetch(
  sub: DisposableStore,
  services: WorkbenchServices,
  repositories: ReadonlySignal<readonly GitRepo[]>,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Repositories whose last autofetch failed (by controller). */
  const failed = new WeakSet<GitRepo>();
  let disposed = false;
  let running = false;
  const schedule = () => {
    clearTimeout(timer);
    if (disposed) return;
    if (services.settings.peek<boolean>("git.autofetch") !== true) return;
    const ms = autofetchPeriod(services.settings.peek("git.autofetchPeriod")) * 1000;
    timer = setTimeout(() => void tick(), ms);
  };
  const tick = async () => {
    if (!document.hidden && !running) {
      running = true;
      try {
        for (const git of repositories.peek()) {
          if (disposed) break;
          const remotes = git.repoState.peek()?.remotes ?? [];
          // Checked again before each fetch: the previous one may have taken a while.
          if (failed.has(git) || !git.repo.peek() || !remotes.length || git.busy.peek()) continue;
          try {
            await git.ipc.remote("fetch", () => {});
            await git.refresh();
          } catch {
            failed.add(git);
          }
        }
      } finally {
        running = false;
      }
    }
    schedule();
  };
  schedule();
  sub.add(
    services.settings.model.onDidChange((keys) => {
      if (restartsAutofetch(keys)) schedule();
    }),
  );
  // A fetch, pull or push of your own finished in a repository (it may have signed in):
  // autofetch tries it again after a failure. Not on every change in .git, which would bring the
  // sign-in prompt back after each stage or commit.
  const wasRemote = new WeakSet<GitRepo>();
  sub.add(
    effect(() => {
      for (const git of repositories.value) {
        const busy = git.busy.value;
        if (busy && /^(Fetching|Pulling|Pushing|Syncing)/.test(busy)) wasRemote.add(git);
        else if (!busy && wasRemote.has(git)) {
          wasRemote.delete(git);
          failed.delete(git);
        }
      }
      return undefined;
    }),
  );
  sub.add({
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
    },
  });
}
