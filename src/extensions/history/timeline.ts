// The Timeline sidebar section (D196, VS Code's Timeline): the active file's local-history
// versions (every save, agent edit, replace all, outside change) and the git commits that changed
// it, newest first, grouped by day. Click one to compare it with the file now; right-click to
// restore a version or copy a commit's hash. It sits under the Explorer, like Outline.
// State: ide://timeline (the same list for agents).

import { h, on, replaceChildren } from "../../core/dom/index";
import { groupTimeline, mergeTimeline, type TimelineItem } from "../../core/history/timeline";
import { historyIpc } from "../../core/ipc/fs";
import { gitIpc } from "../../core/ipc/git";
import { clipboardIpc } from "../../core/ipc/system";
import { DisposableStore } from "../../core/lifecycle/index";
import { basename, samePath } from "../../core/paths/index";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { icon } from "../../ui/Icon";
import { showContextMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { ago, sourceLabel } from "./labels";

interface Loaded {
  path: string | null;
  items: TimelineItem[];
  loading: boolean;
}

export function registerTimeline(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, dock, events, state, workspace, views } = services;
  const data = signal<Loaded>({ path: null, items: [], loading: false });
  /** The file shown: the last text editor that was active (the Timeline keeps it while you look elsewhere). */
  const file = signal<string | null>(null);
  sub.add(
    effect(() => {
      dock.root.value;
      dock.focusedGroupId.value;
      const tab = dock.activeTab();
      if (tab?.viewType !== "editor") return undefined;
      const p = stateField(tab.viewState, "path");
      if (typeof p === "string" && !p.startsWith("virtual:")) file.value = p;
      return undefined;
    }),
  );
  sub.add(workspace.onDidClose(() => (file.value = null)));

  let seq = 0;
  const load = async () => {
    const path = file.peek();
    const mine = ++seq;
    if (!path) {
      data.value = { path: null, items: [], loading: false };
      return;
    }
    data.value = { path, items: data.peek().path === path ? data.peek().items : [], loading: true };
    // Any of the workspace's folders (D251).
    const [local, commits] = await Promise.all([
      historyIpc.list(path).catch(() => []),
      workspace.contains(path) ? gitIpc.log(50, path).catch(() => []) : Promise.resolve([]),
    ]);
    if (mine !== seq) return;
    data.value = { path, items: mergeTimeline(local, commits), loading: false };
  };
  sub.add(
    effect(() => {
      file.value;
      void load();
      return undefined;
    }),
  );
  // A save, an agent edit or a commit adds an entry.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 400);
  };
  sub.add({ dispose: () => clearTimeout(timer) });
  for (const name of ["files.didSave", "files.didChange"] as const)
    sub.add(
      events.on(name, ({ path }) => (samePath(path, file.peek() ?? "") ? soon() : undefined)),
    );
  sub.add(
    events.on("command.executed", (e) => {
      if (
        /^git\.(commit|checkout|pull|merge|rebase|stash)/.test(e.id) ||
        e.id === "history.restore"
      )
        soon();
    }),
  );

  const open = (item: TimelineItem) => {
    const path = data.peek().path;
    if (!path) return;
    if (item.kind === "local")
      void dispatcher
        .execute("editor.openDiff", {
          path,
          version: item.id,
          versionLabel: `${sourceLabel(item.source)}, ${ago(item.time)}`,
        })
        .catch(() => {});
    else void dispatcher.execute("git.fileHistory", { path, commit: item.id }).catch(() => {});
  };

  sub.add(
    views.register({
      id: "timeline.view",
      title: "Timeline",
      icon: "history",
      command: "timeline.show",
      sectionOf: "explorer.view",
      // Below Outline, as in VS Code.
      sectionOrder: 20,
      actions: [{ command: "timeline.refresh", icon: "refresh-cw", title: "Refresh" }],
      create: (host) => {
        const store = new DisposableStore();
        /** The rows' listeners, replaced on each render. */
        const rowsStore = store.add(new DisposableStore());
        const list = h("div", { class: "timeline-list", role: "list" });
        const empty = h("div", { class: "empty-state timeline-empty" });
        const root = h("div", { class: "timeline-view" }, list, empty);
        host.append(root);
        const row = (item: TimelineItem) => {
          const label =
            item.kind === "local" ? sourceLabel(item.source) : item.subject || "(no message)";
          const detail =
            item.kind === "local" ? ago(item.time) : `${item.author} · ${ago(item.time)}`;
          const el = h(
            "button",
            {
              class: "timeline-row",
              type: "button",
              role: "listitem",
              "data-kind": item.kind,
              "data-id": item.id,
            },
            icon(item.kind === "local" ? "history" : "git-commit-horizontal"),
            h("span", { class: "timeline-label" }, label),
            h("span", { class: "timeline-detail" }, detail),
          );
          setTooltip(
            el,
            item.kind === "local"
              ? `${label} · ${new Date(item.time).toLocaleString()} — click to compare with the file now`
              : `${item.subject}\n${item.author} · ${new Date(item.time).toLocaleString()} · ${item.id.slice(0, 7)}`,
          );
          rowsStore.add(on(el, "click", () => open(item)));
          rowsStore.add(
            on(el, "contextmenu", (e) => {
              e.preventDefault();
              const path = data.peek().path;
              if (!path) return;
              showContextMenu(e.clientX, e.clientY, [
                { label: "Compare with file", icon: "git-compare", run: () => open(item) },
                ...(item.kind === "local"
                  ? [
                      {
                        label: "Restore this version",
                        icon: "rotate-ccw" as const,
                        run: () =>
                          void dispatcher
                            .execute("history.restore", { path, id: item.id })
                            .catch(() => {}),
                      },
                    ]
                  : [
                      {
                        label: "Copy commit hash",
                        icon: "copy" as const,
                        run: () => void clipboardIpc.writeText(item.id).catch(() => {}),
                      },
                    ]),
              ]);
            }),
          );
          return el;
        };
        store.add(
          effect(() => {
            const { path, items, loading } = data.value;
            rowsStore.clear();
            const groups = groupTimeline(items);
            replaceChildren(
              list,
              ...groups.flatMap((g) => [
                h("div", { class: "timeline-group" }, g.label),
                ...g.items.map(row),
              ]),
            );
            empty.hidden = items.length > 0;
            list.hidden = items.length === 0;
            replaceChildren(
              empty,
              h("span", { class: "empty-state-icon" }, icon("history")),
              h(
                "div",
                { class: "empty-state-title" },
                !path
                  ? "Open a file to see its timeline"
                  : loading
                    ? "Loading…"
                    : `No history for ${basename(path)} yet`,
              ),
              path && !loading
                ? h(
                    "div",
                    { class: "empty-state-detail" },
                    "Versions are kept each time the file is saved or changed by the app.",
                  )
                : null,
            );
            return undefined;
          }),
        );
        return {
          focus: () => (list.querySelector<HTMLElement>(".timeline-row") ?? root).focus(),
          dispose: () => {
            store.dispose();
            root.remove();
          },
        };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "timeline.show",
      title: "Show timeline",
      category: "View",
      description:
        "Shows the Timeline (under the Explorer): the active file's saved versions and its git commits, newest first.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: () => dispatcher.execute("view.show", { id: "timeline.view" }),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "timeline.refresh",
      title: "Refresh timeline",
      category: "View",
      description: "Reloads the Timeline's list for the active file.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: async () => {
        await load();
        return { items: data.peek().items.length };
      },
    }),
  );
  sub.add(
    state.register("ide://timeline", {
      description:
        "The Timeline (D196): the file it shows and its versions, newest first — local history (id for history.restore / editor.openDiff `version`) and git commits (hash for git.fileHistory `commit`).",
      get: () => {
        const { path, items } = data.peek();
        return {
          path: path ? workspace.relative(path) : null,
          items: items.slice(0, 100).map((i) =>
            i.kind === "local"
              ? { kind: "local", id: i.id, when: new Date(i.time).toISOString(), source: i.source }
              : {
                  kind: "git",
                  hash: i.id,
                  when: new Date(i.time).toISOString(),
                  subject: i.subject,
                  author: i.author,
                },
          ),
        };
      },
    }),
  );
}
