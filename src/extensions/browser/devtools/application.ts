// DevTools Application: the page's local storage, session storage and cookies — view, edit
// (double-click a value), add, delete, clear — and (D146) its IndexedDB databases (stores and
// their first entries), Cache storage (cached requests) and service workers (unregister), each
// deletable. Uses the bridge's storage.* and app.* methods; what the engine lacks says so.
import { h, on } from "../../../core/dom/index";
import { DisposableStore } from "../../../core/lifecycle/index";
import { confirmAction } from "../../../ui/Dialog";
import { type IconName, icon } from "../../../ui/Icon";
import {
  type DevtoolsHost,
  type DevtoolsPanel,
  filterInput,
  iconButton,
  splitPanes,
} from "./common";

type Area = "local" | "session" | "cookie";
const AREAS: [Area, string][] = [
  ["local", "Local storage"],
  ["session", "Session storage"],
  ["cookie", "Cookies"],
];

type Selection =
  | { kind: "storage"; area: Area }
  | { kind: "idb"; db: string; store: string }
  | { kind: "cache"; name: string }
  | { kind: "workers" };

interface Database {
  name: string;
  version?: number;
  stores: { name: string; keyPath: string | null; count: number }[];
  error?: string;
}

const same = (a: Selection, b: Selection) => JSON.stringify(a) === JSON.stringify(b);

export class ApplicationPanel implements DevtoolsPanel {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  /** Listeners of what's rendered now (cleared on each render). */
  private readonly rows = new DisposableStore();
  private readonly nav: HTMLElement;
  private readonly table: HTMLElement;
  private readonly storageTools: HTMLElement;
  private selection: Selection = { kind: "storage", area: "local" };
  private data: Record<Area, [string, string][]> = { local: [], session: [], cookie: [] };
  private databases: Database[] = [];
  private cacheList: { name: string; count: number }[] = [];
  private workers: { scope: string; state: string; script: string }[] = [];
  private supported = { idb: true, caches: true, workers: true };
  private entries: [string, string][] = [];
  private origin = "";
  private filter = "";

  constructor(private readonly host: DevtoolsHost) {
    const s = this.store;
    const clearAll = h("button", { class: "dt-chip", type: "button" }, "Clear site data");
    s.add(on(clearAll, "click", () => void this.clear("all")));
    this.nav = h("div", { class: "dt-app-nav" });
    this.table = h("div", { class: "dt-app-table" });
    this.storageTools = h(
      "span",
      { class: "dt-toolbar-group" },
      iconButton(s, "plus", "Add an entry", () => void this.add()),
      iconButton(s, "ban", "Clear this storage", () => {
        if (this.selection.kind === "storage") void this.clear(this.selection.area);
      }),
    );
    this.element = h(
      "div",
      { class: "dt-panel dt-application" },
      h(
        "div",
        { class: "dt-toolbar" },
        iconButton(s, "refresh-cw", "Refresh", () => void this.load()),
        this.storageTools,
        filterInput(s, "Filter", (t) => {
          this.filter = t;
          this.renderTable();
        }),
        h("span", { class: "dt-spacer" }),
        clearAll,
      ),
      splitPanes(this.store, this.nav, this.table, {
        key: "application",
        sized: "first",
        size: 200,
        stackBelow: 440,
        stackedShare: 0.4,
        min: 120,
      }),
    );
  }

  onShow(): void {
    void this.load();
  }

  private call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.host.page.call<T>(method, params);
  }

  private async load(): Promise<void> {
    try {
      const r = await this.call<{
        origin: string;
        local: [string, string][];
        session: [string, string][];
        cookies: [string, string][];
      }>("storage.list");
      this.data = { local: r.local, session: r.session, cookie: r.cookies };
      this.origin = r.origin;
    } catch (err) {
      this.table.replaceChildren(
        h("div", { class: "dt-empty" }, err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    // The rest may be missing in this engine or blocked for this origin: shown as such.
    const [idb, cache, sw] = await Promise.all([
      this.call<{ databases: Database[]; supported: boolean }>("app.indexedDB").catch(() => null),
      this.call<{ caches: { name: string; count: number }[]; supported: boolean }>(
        "app.caches",
      ).catch(() => null),
      this.call<{
        workers: { scope: string; state: string; script: string }[];
        supported: boolean;
      }>("app.serviceWorkers").catch(() => null),
    ]);
    this.databases = idb?.databases ?? [];
    this.cacheList = cache?.caches ?? [];
    this.workers = sw?.workers ?? [];
    this.supported = {
      idb: idb?.supported ?? false,
      caches: cache?.supported ?? false,
      workers: sw?.supported ?? false,
    };
    await this.loadEntries();
    this.render();
  }

  /** The selected store's or cache's entries. */
  private async loadEntries(): Promise<void> {
    const sel = this.selection;
    this.entries = [];
    try {
      if (sel.kind === "idb")
        this.entries = (
          await this.call<{ entries: [string, string][] }>("app.indexedDBEntries", {
            db: sel.db,
            store: sel.store,
          })
        ).entries;
      else if (sel.kind === "cache")
        this.entries = (
          await this.call<{ entries: [string, string][] }>("app.cacheEntries", { name: sel.name })
        ).entries;
    } catch {
      this.entries = [];
    }
  }

  private select(sel: Selection): void {
    this.selection = sel;
    void this.loadEntries().then(() => this.render());
  }

  private navItem(
    sel: Selection,
    iconName: IconName,
    label: string,
    count: number | null,
    depth = 0,
  ) {
    const b = h(
      "button",
      {
        class: `dt-app-item${same(sel, this.selection) ? " is-selected" : ""}`,
        type: "button",
        style: { "--depth": String(depth) },
      },
      icon(iconName),
      h("span", { class: "dt-app-label" }, label),
      count === null ? null : h("span", { class: "dt-app-count" }, String(count)),
    );
    this.rows.add(on(b, "click", () => this.select(sel)));
    return b;
  }

  private render(): void {
    this.rows.clear();
    const heading = (text: string) => h("div", { class: "dt-app-heading" }, text);
    this.nav.replaceChildren(
      heading("Storage"),
      ...AREAS.map(([area, label]) =>
        this.navItem(
          { kind: "storage", area },
          area === "cookie" ? "circle-dot" : "box",
          label,
          this.data[area].length,
        ),
      ),
      heading("IndexedDB"),
      ...(!this.supported.idb
        ? [h("div", { class: "dt-app-none" }, "Not available here")]
        : this.databases.length
          ? this.databases.flatMap((db) => [
              h(
                "div",
                { class: "dt-app-db" },
                icon("box"),
                h("span", { class: "dt-app-label" }, db.name),
              ),
              ...db.stores.map((st) =>
                this.navItem(
                  { kind: "idb", db: db.name, store: st.name },
                  "list-tree",
                  st.name,
                  st.count,
                  1,
                ),
              ),
            ])
          : [h("div", { class: "dt-app-none" }, "No databases")]),
      heading("Cache storage"),
      ...(!this.supported.caches
        ? [h("div", { class: "dt-app-none" }, "Not available here")]
        : this.cacheList.length
          ? this.cacheList.map((c) =>
              this.navItem({ kind: "cache", name: c.name }, "file-archive", c.name, c.count),
            )
          : [h("div", { class: "dt-app-none" }, "No caches")]),
      heading("Background"),
      this.navItem(
        { kind: "workers" },
        "zap",
        "Service workers",
        this.supported.workers ? this.workers.length : null,
      ),
    );
    this.storageTools.hidden = this.selection.kind !== "storage";
    this.renderTable();
  }

  private renderTable(): void {
    const sel = this.selection;
    const matches = ([k, v]: [string, string]) =>
      !this.filter ||
      k.toLowerCase().includes(this.filter) ||
      v.toLowerCase().includes(this.filter);
    const head = (a: string, b: string) =>
      h(
        "div",
        { class: "dt-app-row dt-app-head" },
        h("span", null, a),
        h("span", null, b),
        h("span"),
      );
    if (sel.kind === "storage") {
      const rows = this.data[sel.area].filter(matches);
      this.table.replaceChildren(
        h("div", { class: "dt-note" }, this.origin),
        head("Key", "Value"),
        ...rows.map(([key, value]) => {
          const val = h(
            "span",
            { class: "dt-app-value dt-editable", title: "Double-click to edit" },
            value,
          );
          this.rows.add(on(val, "dblclick", () => void this.edit(sel.area, key, value)));
          const del = h(
            "button",
            { class: "icon-button dt-icon", type: "button", "aria-label": "Delete" },
            icon("trash-2"),
          );
          this.rows.add(
            on(del, "click", async () => {
              await this.call("storage.remove", { area: sel.area, key });
              void this.load();
            }),
          );
          return h(
            "div",
            { class: "dt-app-row" },
            h("span", { class: "dt-app-key" }, key),
            val,
            del,
          );
        }),
        rows.length ? "" : h("div", { class: "dt-empty" }, "Empty."),
      );
      return;
    }
    if (sel.kind === "workers") {
      this.table.replaceChildren(
        h("div", { class: "dt-note" }, this.origin),
        ...(!this.supported.workers
          ? [h("div", { class: "dt-empty" }, "Service workers aren't available in this page.")]
          : this.workers.length
            ? this.workers.map((w) => {
                const stop = h("button", { class: "dt-chip", type: "button" }, "Unregister");
                this.rows.add(
                  on(stop, "click", async () => {
                    await this.call("app.unregisterWorker", { scope: w.scope });
                    void this.load();
                  }),
                );
                return h(
                  "div",
                  { class: "dt-app-card" },
                  h("div", { class: "dt-app-card-title" }, w.scope),
                  h("div", { class: "dt-note" }, `${w.state} · ${w.script}`),
                  stop,
                );
              })
            : [h("div", { class: "dt-empty" }, "No service workers.")]),
      );
      return;
    }
    const rows = this.entries.filter(matches);
    const remove = h(
      "button",
      { class: "dt-chip", type: "button" },
      sel.kind === "idb" ? `Delete database ${sel.db}` : `Delete cache ${sel.name}`,
    );
    this.rows.add(
      on(remove, "click", async () => {
        const what = sel.kind === "idb" ? `the database ${sel.db}` : `the cache ${sel.name}`;
        const ok = await confirmAction(
          `Delete ${what}?`,
          "The page's data in it is removed for good.",
          "Delete",
          true,
        );
        if (!ok) return;
        if (sel.kind === "idb") await this.call("app.deleteDatabase", { name: sel.db });
        else await this.call("app.deleteCache", { name: sel.name });
        this.selection = { kind: "storage", area: "local" };
        void this.load();
      }),
    );
    this.table.replaceChildren(
      h(
        "div",
        { class: "dt-app-bar" },
        h(
          "span",
          { class: "dt-note" },
          sel.kind === "idb" ? `${sel.db} › ${sel.store} (read-only, first 200)` : sel.name,
        ),
        remove,
      ),
      head(sel.kind === "idb" ? "Key" : "Request", sel.kind === "idb" ? "Value" : "Response"),
      ...rows.map(([k, v]) =>
        h(
          "div",
          { class: "dt-app-row" },
          h("span", { class: "dt-app-key" }, k),
          h("span", { class: "dt-app-value" }, v),
          h("span"),
        ),
      ),
      rows.length ? "" : h("div", { class: "dt-empty" }, "Empty."),
    );
  }

  private async edit(area: Area, key: string, value: string): Promise<void> {
    const next = await this.host.services.quickInput.prompt({ prompt: `Value of ${key}`, value });
    if (next === undefined) return;
    await this.call("storage.set", { area, key, value: next });
    void this.load();
  }

  private async add(): Promise<void> {
    if (this.selection.kind !== "storage") return;
    const area = this.selection.area;
    const key = await this.host.services.quickInput.prompt({ prompt: "Key", value: "" });
    if (!key) return;
    const value = await this.host.services.quickInput.prompt({
      prompt: `Value of ${key}`,
      value: "",
    });
    if (value === undefined) return;
    await this.call("storage.set", { area, key, value });
    void this.load();
  }

  private async clear(area: Area | "all"): Promise<void> {
    await this.call("storage.clear", { area });
    void this.load();
  }

  dispose(): void {
    this.rows.dispose();
    this.store.dispose();
  }
}
