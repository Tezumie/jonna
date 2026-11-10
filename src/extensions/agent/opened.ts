// What the agent opened (D179): tabs and windows that appeared while one of its commands ran
// (a page, a browser tab, a view moved into its own window). The owner asked for a way out when
// the agent opens something they can't see or don't want: agent.closeOpened closes all of it
// (Ctrl+Shift+Alt+W, the panel's ⋯ menu), layout.returnAllWindows brings every window's tab
// back, and agent.closeOpenedOnStop closes a chat's tabs when you stop it.
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";

/** Tabs opened per chat, newest last (a closed tab is forgotten). */
export class OpenedByAgent {
  private readonly bySession = new Map<string, string[]>();

  add(session: string, tabIds: readonly string[]): void {
    if (!tabIds.length) return;
    const list = this.bySession.get(session) ?? [];
    for (const id of tabIds) if (!list.includes(id)) list.push(id);
    // A long session doesn't keep every tab it ever opened.
    this.bySession.set(session, list.slice(-200));
  }

  /** The chat's tabs that still exist (all chats when no session is given). */
  live(exists: (tabId: string) => boolean, session?: string): string[] {
    const sessions = session ? [session] : [...this.bySession.keys()];
    const out: string[] = [];
    for (const id of sessions) {
      const list = (this.bySession.get(id) ?? []).filter(exists);
      if (list.length) this.bySession.set(id, list);
      else this.bySession.delete(id);
      out.push(...list);
    }
    return out;
  }

  forget(session?: string): void {
    if (session) this.bySession.delete(session);
    else this.bySession.clear();
  }
}

export function registerOpenedTracking(
  sub: DisposableStore,
  services: WorkbenchServices,
): OpenedByAgent {
  const { dock, dispatcher, events } = services;
  const opened = new OpenedByAgent();
  const tabIds = () => new Set(dock.tabs().map((t) => t.id));
  /**
   * Tabs that existed when each running agent command started, by execution number. A command
   * that overlapped another one, or ran long (a wait, a slow page), isn't credited with new tabs:
   * the user (or another chat) may have opened them meanwhile, and closing one of theirs is worse
   * than leaving one of the agent's open.
   */
  const before = new Map<
    number,
    { session: string; tabs: Set<string>; started: number; overlapped: boolean }
  >();
  sub.add(
    events.on("command.started", (e) => {
      if (e.caller.kind !== "agent" && e.caller.kind !== "acp") return;
      for (const other of before.values()) other.overlapped = true;
      before.set(e.execution, {
        session: e.caller.session,
        tabs: tabIds(),
        started: performance.now(),
        overlapped: before.size > 0,
      });
      // A command that never reports back (a crash) doesn't leave its snapshot forever.
      if (before.size > 100) before.delete(before.keys().next().value as number);
    }),
  );
  sub.add(
    events.on("command.executed", (e) => {
      const start = before.get(e.execution);
      if (!start) return;
      before.delete(e.execution);
      if (start.overlapped || performance.now() - start.started > 3000) return;
      const added = [...tabIds()].filter((id) => !start.tabs.has(id));
      // Tabs the agent panel makes for its own chats are the user's.
      const own = added.filter((id) => {
        const found = dock.findTab(id);
        return found && found.group.tabs[found.index]?.viewType !== "agent";
      });
      opened.add(start.session, own);
    }),
  );

  const exists = (id: string) => !!dock.findTab(id);
  const close = async (session?: string) => {
    const ids = opened.live(exists, session);
    let closed = 0;
    // Not forced: an editor with unsaved changes (the agent's or yours) asks Save / Don't save.
    for (const id of ids.reverse()) if (await dock.closeTab(id)) closed++;
    // Tabs kept open (Cancel on an unsaved one) stay listed; closed ones drop out by themselves.
    return closed;
  };

  sub.add(
    dispatcher.register({
      id: "agent.closeOpened",
      title: "Close what the agent opened",
      category: "Agent",
      description:
        "Closes every tab and window the agent opened (pages, browser tabs, panels, views moved into their own windows), for one chat (`session`) or all of them. Unsaved editors close without saving only if the user agrees.",
      input: s.object({
        session: s.string().describe("Chat id; default: every chat").optional(),
        quiet: s.boolean().describe("No notice when nothing is open (Stop uses it)").optional(),
      }),
      effects: [],
      agent: "hidden",
      run: async ({ session, quiet }) => {
        const count = opened.live(exists, session).length;
        if (!count) {
          if (!quiet)
            services.notifications.show(
              "info",
              "The agent hasn't opened anything that's still open.",
            );
          return { closed: 0 };
        }
        const closed = await close(session);
        return { closed };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.listOpened",
      title: "List what the agent opened",
      category: "Agent",
      description: "The tabs the agent opened that are still open (ids, titles, view types).",
      input: s.object({ session: s.string().optional() }),
      effects: ["read"],
      palette: false,
      run: ({ session }) => ({
        tabs: opened.live(exists, session).map((id) => {
          const found = dock.findTab(id);
          const tab = found?.group.tabs[found.index];
          return { id, viewType: tab?.viewType ?? null, title: tab ? dock.title(tab) : null };
        }),
      }),
    }),
  );

  return opened;
}
