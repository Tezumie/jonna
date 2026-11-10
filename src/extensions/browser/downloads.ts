// Downloads from browser tabs, site windows and sites inside tabs (Rust `downloads.rs`): a
// `downloads` dock tab (name, progress, open, show in folder, cancel), a status bar entry while
// there are any, commands (`browser.downloads`, `browser.showDownloads`, `browser.openDownload`,
// `browser.revealDownload`, `browser.cancelDownload`, `browser.clearDownloads`) and
// `ide://downloads`. The list itself is `downloadsModel.ts` (tested).
import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { browserIpc, type Download } from "../../core/ipc/browser";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { effect, type Signal, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { applyDownload, describe, fraction, statusText, summary } from "./downloadsModel";

type Register = WorkbenchServices["dispatcher"]["register"];

class DownloadsView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();

  constructor(
    list: Signal<Download[]>,
    private readonly run: (command: string, input?: unknown) => void,
  ) {
    const rows = h("div", { class: "downloads-list", role: "list" });
    const clear = h(
      "button",
      { class: "button button-ghost", type: "button" },
      "Clear finished",
    ) as HTMLButtonElement;
    this.store.add(on(clear, "click", () => this.run("browser.clearDownloads")));
    const head = h("div", { class: "downloads-head" }, clear);
    this.element = h("div", { class: "downloads-view" }, head, rows);
    this.store.add(
      effect(() => {
        const items = list.value;
        clear.disabled = !items.some((d) => d.state !== "progress");
        rows.replaceChildren(
          ...(items.length
            ? items.map((d) => this.row(d))
            : [
                h(
                  "div",
                  { class: "empty-state" },
                  icon("download"),
                  h("div", { class: "empty-state-title" }, "No downloads"),
                  h(
                    "div",
                    { class: "empty-state-text" },
                    "Files the browser tabs download show here.",
                  ),
                ),
              ]),
        );
        return undefined;
      }),
    );
  }

  private row(d: Download): HTMLElement {
    const action = (name: Parameters<typeof icon>[0], title: string, command: string) => {
      const b = h("button", { class: "icon-button", type: "button" }, icon(name));
      setTooltip(b, title);
      b.addEventListener("click", () => this.run(command, { id: d.id }));
      return b;
    };
    const done = d.state === "done";
    const share = fraction(d);
    const bar =
      d.state === "progress"
        ? h(
            "div",
            { class: { "download-bar": true, "is-indeterminate": share === null } },
            h("div", {
              class: "download-bar-fill",
              style: share === null ? {} : { width: `${Math.round(share * 100)}%` },
            }),
          )
        : null;
    const name = h("div", { class: "download-name" }, d.fileName);
    setTooltip(name, d.path ?? d.url);
    const row = h(
      "div",
      { class: { "download-row": true, [`is-${d.state}`]: true }, role: "listitem" },
      icon(done ? "file-down" : d.state === "progress" ? "download" : "circle-x"),
      h(
        "div",
        { class: "download-main" },
        name,
        h("div", { class: "download-detail" }, describe(d)),
        bar,
      ),
      h(
        "div",
        { class: "download-actions" },
        ...(done
          ? [
              action("external-link", "Open", "browser.openDownload"),
              action("folder-open", "Show in folder", "browser.revealDownload"),
            ]
          : []),
        ...(d.state === "progress" && d.canCancel
          ? [action("x", "Cancel", "browser.cancelDownload")]
          : []),
      ),
    );
    // Double-click opens a finished file, as in a browser's downloads list.
    if (done)
      row.addEventListener("dblclick", () => this.run("browser.openDownload", { id: d.id }));
    return row;
  }

  title(): string {
    return "Downloads";
  }

  serialize(): Json {
    return null;
  }

  dispose(): void {
    this.store.dispose();
  }
}

/** The downloads list, its tab, status entry, commands and state. `list` is fed by index.ts. */
export function registerDownloads(
  register: Register,
  services: WorkbenchServices,
  list: Signal<Download[]>,
): Disposable {
  const store = new DisposableStore();
  const { dock, dispatcher } = services;
  const run = (command: string, input: unknown = {}) =>
    void dispatcher.execute(command, input).catch(() => {});
  void browserIpc
    .downloads()
    .then((items) => {
      let next = list.peek();
      for (const d of items) next = applyDownload(next, d);
      list.value = next;
    })
    .catch(() => {});

  store.add(
    dock.views.register({
      type: "downloads",
      title: () => "Downloads",
      icon: () => "download",
      singleton: true,
      defaultPlacement: "bottom",
      create: () => new DownloadsView(list, run),
    }),
  );
  const find = (id: number): Download => {
    const d = list.peek().find((x) => x.id === id);
    if (!d) throw new Error(`No download ${id} (browser.downloads lists them).`);
    return d;
  };
  const id = s.integer({ min: 1 }).describe("Download id from browser.downloads");
  register({
    id: "browser.downloads",
    title: "List downloads",
    description:
      "Downloads from the browser tabs this session: file, address, state (progress, done, failed, cancelled), progress and where it was saved.",
    input: s.empty(),
    effects: ["read"],
    agent: "discoverable",
    run: () => ({ downloads: list.peek().map(summary) }),
  });
  register({
    id: "browser.showDownloads",
    title: "Show downloads",
    description: "Opens the Downloads tab (the browser tabs' downloads).",
    input: s.empty(),
    effects: [],
    run: () => {
      dock.openView("downloads", null, "bottom", true);
    },
  });
  register({
    id: "browser.openDownload",
    title: "Open downloaded file",
    description: "Opens a finished download with the system's program for it.",
    input: s.object({ id }),
    effects: ["exec"],
    palette: false,
    run: async ({ id: which }) => {
      await browserIpc.openDownload(find(which).id);
      return { opened: true };
    },
  });
  register({
    id: "browser.revealDownload",
    title: "Show download in folder",
    description: "Shows a finished download in the system's file manager.",
    input: s.object({ id }),
    effects: [],
    palette: false,
    run: async ({ id: which }) => {
      await browserIpc.revealDownload(find(which).id);
      return { shown: true };
    },
  });
  register({
    id: "browser.cancelDownload",
    title: "Cancel download",
    description: "Cancels a running download (Windows; other platforms can't cancel from the IDE).",
    input: s.object({ id }),
    effects: ["write"],
    palette: false,
    agent: "discoverable",
    run: async ({ id: which }) => {
      await browserIpc.cancelDownload(find(which).id);
      return { cancelling: true };
    },
  });
  register({
    id: "browser.clearDownloads",
    title: "Clear finished downloads",
    description: "Removes finished, failed and cancelled downloads from the list (the files stay).",
    input: s.empty(),
    effects: [],
    run: async () => {
      await browserIpc.clearDownloads();
      list.value = list.peek().filter((d) => d.state === "progress");
      return { remaining: list.peek().length };
    },
  });
  store.add(
    services.state.register("ide://downloads", {
      description:
        "Downloads from the browser tabs this session: file, address, state, progress, saved path. browser.openDownload / revealDownload / cancelDownload act on them by id.",
      get: () => list.peek().map(summary),
    }),
  );
  store.add(
    services.statusBar.add({
      id: "browser.downloads",
      name: "Downloads",
      alignment: "right",
      priority: 29,
      text: () => statusText(list.value)?.text ?? "",
      tooltip: () => statusText(list.value)?.tooltip ?? "",
      command: "browser.showDownloads",
    }),
  );
  return store;
}

/** A new signal for the list (kept by index.ts, which receives the reports). */
export function downloadsSignal(): Signal<Download[]> {
  return signal<Download[]>([]);
}

export { applyDownload };
