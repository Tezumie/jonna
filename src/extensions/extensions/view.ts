// The Extensions sidebar view (VS Code's layout, our look): a filter box, then "Installed",
// "Recommended" (for this workspace, from Open VSX) and "Development" sections of two-line rows —
// avatar, name, version, description, publisher and badges — with a gear menu (also on
// right-click). Clicking a row opens the extension's page; an Open VSX row opens its store page.
// Open VSX icons load when their row is first seen.

import { h, on, replaceChildren } from "../../core/dom/index";
import { authorsText } from "../../core/extensions/authors";
import {
  filterText,
  type InstalledFacts,
  installedOnly,
  isEmptyQuery,
  matchesInstalled,
  parseExtensionQuery,
} from "../../core/extensions/extensionQuery";
import { formatCount, STORE_CATEGORIES, type StoreItem } from "../../core/extensions/openVsx";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect, signal } from "../../core/reactive/index";
import { icon } from "../../ui/Icon";
import { type MenuItem, showContextMenu, showMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import type { WorkbenchServices } from "../../workbench/services";
import type { ViewInstance } from "../../workbench/views";
import { fromStore } from "./actions";
import type { ExtensionManager, ExtensionRecord, WorkspaceExtension } from "./manager";
import { actionsMenu, avatar, badges, installMore, verifiedMark } from "./parts";
import {
  isVerified,
  pendingUpdate,
  recommendationsEnabled,
  refreshRecommendations,
  searchStoreQuery,
  storeInstalling,
  storeRecommendations,
  storeResults,
  storeUpdates,
} from "./store";
import { loadStoreIcon, storeAvatar } from "./storeMedia";

export { contributionSummary } from "./parts";

/** Text for the view's filter box, set by `extensions.show { query }` (D204: kernels for notebooks). */
export const extensionsQuery = signal<string | null>(null);

/** What's typed in the search box: the Recommended and Open VSX sections follow it (D258). */
export const extensionsFilter = signal("");

/**
 * Which part of the Extensions view an instance draws (D258, as VS Code's panes): the search box
 * and the installed extensions, or one of the sections below them (Recommended while nothing is
 * typed, Open VSX's results while something is), each collapsible, resizable and scrolling on
 * its own like the Explorer's Outline and Timeline.
 */
export type ExtensionsPart = "main" | "recommended" | "store";

/** Whether a section shows now (read reactively by the sidebar). */
export function extensionsSectionShown(services: WorkbenchServices, part: ExtensionsPart): boolean {
  const q = extensionsFilter.value.trim();
  const parsed = parseExtensionQuery(q);
  services.settings.version.value;
  if (part === "recommended")
    return (
      (!q || (parsed.recommended && !parsed.text)) &&
      recommendationsEnabled(services) &&
      storeRecommendations.value.items.length > 0
    );
  if (part === "store")
    return (
      storeSearched(q) && services.settings.peek<boolean>("extensions.store.enabled") !== false
    );
  return true;
}

/**
 * Whether what's typed searches Open VSX (D284, VS Code's): two letters of text, or a filter the
 * store answers (`publisher:`, `@category:`, `@popular`…); never the installed-only ones.
 */
function storeSearched(raw: string): boolean {
  const q = parseExtensionQuery(raw);
  if (isEmptyQuery(q) || installedOnly(q)) return false;
  return (
    q.text.length >= 2 ||
    !!(q.publisher || q.category || q.id || q.tag) ||
    q.popular ||
    q.recentlyPublished
  );
}

export class ExtensionsView implements ViewInstance {
  private readonly store = new DisposableStore();
  /** Drawn once; later changes redraw at most once a frame (D379). */
  private drawn = false;
  private frame = 0;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly filter: HTMLInputElement;
  private readonly query = extensionsFilter;
  private readonly collapsed = new Set<string>();
  /** Open VSX icons are fetched when their row scrolls into view, not for every result. */
  private readonly icons: IntersectionObserver | null;

  constructor(
    host: HTMLElement,
    private readonly services: WorkbenchServices,
    private readonly manager: ExtensionManager,
    private readonly part: ExtensionsPart = "main",
  ) {
    this.filter = h("input", {
      class: "input ext-filter-input",
      type: "search",
      placeholder: "Search extensions",
      spellcheck: "false",
      "aria-label": "Search extensions",
    }) as HTMLInputElement;
    this.filter.value = this.query.peek();
    this.store.add(on(this.filter, "input", () => (this.query.value = this.filter.value)));
    this.store.add(
      effect(() => {
        const asked = extensionsQuery.value;
        if (asked === null) return undefined;
        this.filter.value = asked;
        this.query.value = asked;
        queueMicrotask(() => (extensionsQuery.value = null));
        return undefined;
      }),
    );
    this.list = h("div", { class: "ext-list", role: "list" });
    const button = (label: string, command: string, primary = false) =>
      h(
        "button",
        {
          class: `button ${primary ? "button-accent" : "button-secondary"} button-sm`,
          type: "button",
          "data-command": command,
        },
        label,
      );
    this.empty = h(
      "div",
      { class: "ext-empty" },
      h("div", { class: "ext-empty-icon" }, icon("blocks")),
      h("p", { class: "ext-empty-title" }, "No extensions yet"),
      h(
        "p",
        { class: "ext-empty-hint" },
        "Create one from a template (or ask the agent to build one), install an extension folder, or load one unpacked while you develop it. VS Code color themes, grammars and snippets work too.",
      ),
      h(
        "div",
        { class: "ext-empty-actions" },
        button("Create extension…", "extensions.create", true),
        button("Install from folder…", "extensions.installFromFolder"),
        button("Load unpacked…", "extensions.loadUnpacked"),
      ),
    );
    // The search box stays put; the list under it scrolls (D258).
    const root =
      part === "main"
        ? h(
            "div",
            { class: "ext-view" },
            h("div", { class: "ext-filter" }, this.filter, this.filterButton()),
            this.empty,
            this.list,
          )
        : h("div", { class: "ext-view is-section" }, this.list);
    if (part !== "main") this.empty.hidden = true;
    host.append(root);
    this.icons =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                if (!entry.isIntersecting || !(entry.target instanceof HTMLElement)) continue;
                this.icons?.unobserve(entry.target);
                loadStoreIcon(entry.target);
              }
            },
            { root: null, rootMargin: "120px" },
          );
    this.store.add({ dispose: () => this.icons?.disconnect() });
    this.store.add(
      on(root, "click", (e) => {
        const target = e.target instanceof Element ? e.target : null;
        const id = target?.closest<HTMLElement>("[data-ext]")?.dataset.ext;
        const gear = target?.closest<HTMLElement>(".ext-gear");
        if (gear && id) {
          e.stopPropagation();
          const r = this.manager.get(id);
          if (r)
            showMenu(
              gear,
              actionsMenu(this.services, r, { manager: this.manager }),
              "Extension actions",
            );
          return;
        }
        // An installed extension's Update (D284).
        const update = target?.closest<HTMLElement>("[data-update]")?.dataset.update;
        if (update) {
          e.stopPropagation();
          void this.services.dispatcher
            .execute("extensions.updateFromStore", { id: update })
            .catch((err: unknown) =>
              this.services.notifications.show(
                "error",
                err instanceof Error ? err.message : String(err),
              ),
            );
          return;
        }
        // An Open VSX result's Install / Update (D254).
        const install = target?.closest<HTMLElement>("[data-install]")?.dataset.install;
        if (install) {
          e.stopPropagation();
          void this.services.dispatcher
            .execute("extensions.installFromStore", { id: install })
            .catch((err: unknown) =>
              this.services.notifications.show(
                "error",
                err instanceof Error ? err.message : String(err),
              ),
            );
          return;
        }
        const storeId = target?.closest<HTMLElement>("[data-store-ext]")?.dataset.storeExt;
        const commandEl = target?.closest<HTMLElement>("[data-command]");
        const command = commandEl?.dataset.command;
        if (command) {
          e.stopPropagation();
          const folder = commandEl?.dataset.folder;
          const commandId = id ?? storeId;
          void this.services.dispatcher
            .execute(command, folder ? { folder } : commandId ? { id: commandId } : {})
            .catch(() => {});
          return;
        }
        const section = target?.closest<HTMLElement>("[data-section]")?.dataset.section;
        if (section) {
          if (this.collapsed.has(section)) this.collapsed.delete(section);
          else this.collapsed.add(section);
          this.render();
          return;
        }
        if (id) this.open(id);
        else if (storeId) this.openStore(storeId);
      }),
    );
    this.store.add(
      on(root, "contextmenu", (e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (target?.closest("input")) return;
        const id = target?.closest<HTMLElement>("[data-ext]")?.dataset.ext;
        const r = id ? this.manager.get(id) : undefined;
        e.preventDefault();
        if (r)
          showContextMenu(
            e.clientX,
            e.clientY,
            actionsMenu(this.services, r, { manager: this.manager }),
          );
        else
          showContextMenu(e.clientX, e.clientY, [
            { label: "Create extension…", icon: "plus", run: () => this.run("extensions.create") },
            {
              label: "Install from folder…",
              icon: "download",
              run: () => this.run("extensions.installFromFolder"),
            },
            {
              label: "Install from VSIX…",
              icon: "file-archive",
              run: () => this.run("extensions.installFromVsix"),
            },
            {
              label: "Load unpacked…",
              icon: "folder-open",
              run: () => this.run("extensions.loadUnpacked"),
            },
            // From a repository, or the official one (D185).
            {
              label: "Install from GitHub…",
              icon: "cloud-download",
              separatorBefore: true,
              run: () => this.run("extensions.installFromRepo"),
            },
            {
              label: "Browse official extensions…",
              icon: "blocks",
              run: () => this.run("extensions.browseOfficial"),
            },
            {
              label: "Reload all",
              icon: "refresh-cw",
              separatorBefore: true,
              run: () => this.run("extensions.reload"),
            },
            // Bundled extensions that were uninstalled come back from here (D183).
            {
              label: "Restore bundled extensions",
              icon: "archive-restore",
              run: () => this.run("extensions.restoreBundled"),
            },
          ]);
      }),
    );
    this.store.add(
      on(root, "keydown", (e) => {
        const target = e.target instanceof HTMLElement ? e.target : null;
        const isRow = target?.classList.contains("ext-row") ?? false;
        const id = isRow ? target?.dataset.ext : undefined;
        const storeId = isRow ? target?.dataset.storeExt : undefined;
        if ((!id && !storeId) || !target) return;
        if (e.key === "Enter") {
          e.preventDefault();
          if (id) this.open(id);
          else if (storeId) this.openStore(storeId);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const rows = [...this.list.querySelectorAll<HTMLElement>(".ext-row")];
          rows[rows.indexOf(target) + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
        }
      }),
    );
    this.store.add(
      effect(() => {
        this.manager.records.value;
        this.manager.workspace.value;
        this.query.value;
        storeResults.value;
        storeUpdates.value;
        storeInstalling.value;
        storeRecommendations.value;
        // At most once a frame (D379): each extension's activating and active steps replaced
        // the records, and the whole list redrew for each.
        if (!this.drawn) {
          this.drawn = true;
          this.render();
        } else if (!this.frame)
          this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.render();
          });
        return undefined;
      }),
    );
    // The main part asks Open VSX (searches and recommendations); its sections only draw.
    if (part !== "main") return;
    // Recommended (for this workspace): worked out again while the view is shown, when the
    // folders, open editors or installed extensions change. Open VSX is asked only then (and
    // only with the store and recommendations on).
    let recommendTimer: ReturnType<typeof setTimeout> | undefined;
    this.store.add({ dispose: () => clearTimeout(recommendTimer) });
    let lastInputs = "";
    this.store.add(
      effect(() => {
        const shown =
          services.views.active.value === "extensions.view" && services.layout.sidebarVisible.value;
        services.settings.version.value;
        const inputs = JSON.stringify([
          services.workspace.folders.value.map((f) => f.path),
          this.manager.records.value.map((r) => r.id),
          services.dock.tabs("editor").map((t) => (t.viewState as { path?: unknown } | null)?.path),
          recommendationsEnabled(services),
          services.settings.peek<string[]>("extensions.recommendations.ignored") ?? [],
        ]);
        // The dock's tabs: read through its root signal so opening a file counts.
        services.dock.root.value;
        if (!shown || inputs === lastInputs) return undefined;
        clearTimeout(recommendTimer);
        recommendTimer = setTimeout(() => {
          // Hidden again meanwhile: nothing is fetched.
          if (services.views.active.peek() !== "extensions.view") return;
          lastInputs = inputs;
          void refreshRecommendations(services, manager).catch(() => {});
        }, 600);
        return undefined;
      }),
    );
    // What's typed searches Open VSX too, once typing pauses (D254); `@category:Themes` lists a
    // category's most used.
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.store.add({ dispose: () => clearTimeout(timer) });
    this.store.add(
      effect(() => {
        const q = this.query.value.trim();
        clearTimeout(timer);
        if (
          !storeSearched(q) ||
          services.settings.peek<boolean>("extensions.store.enabled") === false
        )
          return undefined;
        timer = setTimeout(() => void searchStoreQuery(services, q), 450);
        return undefined;
      }),
    );
  }

  /** VS Code's filter button in the search box (D284): the filters and sorts it understands. */
  private filterButton(): HTMLElement {
    const b = h(
      "button",
      { class: "icon-button ext-filter-button", type: "button", "aria-label": "Filter extensions" },
      icon("list-filter"),
    );
    setTooltip(b, "Filter extensions…");
    const show = (query: string) =>
      void this.services.dispatcher.execute("extensions.show", { query }).catch(() => {});
    // A sort keeps what's typed and replaces any earlier sort.
    const sorted = (sort: string) =>
      show(
        `${this.query
          .peek()
          .replace(/@sort:\S*/gi, "")
          .trim()} @sort:${sort}`.trim(),
      );
    const flag = (label: string, query: string): MenuItem => ({
      label,
      run: () => show(`${query} `),
    });
    this.store.add(
      on(b, "click", () =>
        showMenu(
          b,
          [
            flag("Most popular", "@popular"),
            flag("Recently published", "@recentlyPublished"),
            flag("Recommended", "@recommended"),
            {
              label: "Category",
              separatorBefore: true,
              submenu: STORE_CATEGORIES.map((c) => flag(c, filterText("@category", c))),
            },
            flag("Installed", "@installed"),
            flag("Enabled", "@enabled"),
            flag("Disabled", "@disabled"),
            flag("Built in", "@builtin"),
            flag("Updates", "@updates"),
            {
              label: "Sort by",
              separatorBefore: true,
              submenu: [
                { label: "Install count", run: () => sorted("installs") },
                { label: "Rating", run: () => sorted("rating") },
                { label: "Name", run: () => sorted("name") },
                { label: "Published date", run: () => sorted("publishedDate") },
                { label: "Updated date", run: () => sorted("updateDate") },
              ],
            },
          ],
          "Filter extensions",
        ),
      ),
    );
    return b;
  }

  private run(command: string): void {
    void this.services.dispatcher.execute(command, {}).catch(() => {});
  }

  private open(id: string): void {
    void this.services.dispatcher.execute("extensions.showDetails", { id }).catch(() => {});
  }

  private render(): void {
    if (this.part !== "main") {
      // A section: its header is the sidebar's (title, collapse, resize).
      const q = this.query.peek().trim();
      const nodes =
        this.part === "recommended" ? this.recommendedSection(false) : this.storeSection(q, false);
      replaceChildren(this.list, ...nodes);
      this.watchIcons();
      return;
    }
    const all = this.manager.records.peek();
    const raw = this.query.peek().trim();
    const q = raw.toLowerCase();
    // VS Code's search syntax (D284): text and filters over the installed extensions; the
    // store-only ones (@popular, @recentlyPublished) show none of them.
    const parsed = parseExtensionQuery(raw);
    const storeOnly = parsed.popular || parsed.recentlyPublished;
    const recommended = new Set(storeRecommendations.peek().items.map((x) => x.id.toLowerCase()));
    const shown = storeOnly
      ? []
      : all.filter((r) => !raw || matchesInstalled(parsed, this.facts(r, recommended)));
    const updatesShown = !raw || parsed.updates;
    const found = this.manager.workspace.peek();
    this.empty.hidden = all.length > 0 || found.length > 0;
    const groups: [key: string, title: string, items: ExtensionRecord[]][] = [
      // Installed extensions with a newer version on Open VSX (Update extensions from the store).
      [
        "updates",
        "Updates",
        updatesShown
          ? storeUpdates
              .peek()
              .map((u) => this.manager.get(u.id))
              .filter((r): r is ExtensionRecord => !!r)
          : [],
      ],
      ["installed", "Installed", shown.filter((r) => !r.dev)],
      ["dev", "Development", shown.filter((r) => r.dev)],
    ];
    const nodes: HTMLElement[] = [];
    for (const [key, title, items] of groups) {
      if (!items.length) continue;
      const open = !this.collapsed.has(key);
      nodes.push(
        h(
          "button",
          {
            class: "ext-section",
            type: "button",
            "data-section": key,
            "aria-expanded": String(open),
          },
          icon(open ? "chevron-down" : "chevron-right"),
          h("span", { class: "ext-section-title" }, title),
          h("span", { class: "ext-section-count" }, String(items.length)),
        ),
      );
      if (open) for (const r of items) nodes.push(this.row(r));
    }
    // Folders in <workspace folder>/extensions that aren't loaded (made by hand or by an agent).
    if (found.length) {
      const open = !this.collapsed.has("folder");
      nodes.push(
        h(
          "button",
          {
            class: "ext-section",
            type: "button",
            "data-section": "folder",
            "aria-expanded": String(open),
          },
          icon(open ? "chevron-down" : "chevron-right"),
          h("span", { class: "ext-section-title" }, "Not loaded"),
          h("span", { class: "ext-section-count" }, String(found.length)),
        ),
      );
      if (open) for (const f of found) nodes.push(this.foundRow(f));
    }
    // Searching: Open VSX's results are the section below; say the installed ones had none.
    if (all.length && !shown.length && !storeOnly)
      nodes.push(
        h(
          "div",
          { class: "ext-none" },
          q.length >= 2 ? "No installed extension matches." : "No extensions match.",
        ),
      );
    const active = document.activeElement as HTMLElement | null;
    const focused = active?.dataset?.ext;
    const focusedStore = active?.dataset?.storeExt;
    replaceChildren(this.list, ...nodes);
    if (focused)
      this.list.querySelector<HTMLElement>(`.ext-row[data-ext="${CSS.escape(focused)}"]`)?.focus();
    else if (focusedStore)
      this.list
        .querySelector<HTMLElement>(`.ext-row[data-store-ext="${CSS.escape(focusedStore)}"]`)
        ?.focus();
    this.watchIcons();
  }

  /** What the search filters read of an installed extension (D284). */
  private facts(r: ExtensionRecord, recommended: ReadonlySet<string>): InstalledFacts {
    const m = r.manifest;
    return {
      id: r.id,
      displayName: m?.displayName ?? "",
      description: m?.description ?? "",
      publisher: m?.publisher ?? "",
      categories: m?.categories ?? [],
      keywords: m?.keywords ?? [],
      fileExtensions: m?.contributes.languages.flatMap((l) => l.extensions ?? []) ?? [],
      enabled: r.status !== "disabled",
      builtin: this.manager.isBundled(r.id),
      hasUpdate: !!pendingUpdate(r.id),
      recommended: recommended.has(r.id.toLowerCase()),
    };
  }

  /** Rows not seen yet fetch their icon when they scroll into view. */
  private watchIcons(): void {
    if (this.icons) {
      this.icons.disconnect();
      for (const el of this.list.querySelectorAll<HTMLElement>("[data-store-icon]"))
        this.icons.observe(el);
    } else
      for (const el of this.list.querySelectorAll<HTMLElement>("[data-store-icon]"))
        loadStoreIcon(el);
  }

  private openStore(id: string): void {
    void this.services.dispatcher
      .execute("extensions.showStoreDetails", { id })
      .catch((err: unknown) =>
        this.services.notifications.show("error", err instanceof Error ? err.message : String(err)),
      );
  }

  /** Recommended for this workspace (its extensions.json, its kinds of files), from Open VSX. */
  private recommendedSection(header = true): HTMLElement[] {
    if (!recommendationsEnabled(this.services)) return [];
    const { items, busy } = storeRecommendations.peek();
    if (!items.length) return [];
    const open = !header || !this.collapsed.has("recommended");
    const out: HTMLElement[] = [];
    if (header)
      out.push(
        h(
          "button",
          {
            class: "ext-section",
            type: "button",
            "data-section": "recommended",
            "aria-expanded": String(open),
          },
          icon(open ? "chevron-down" : "chevron-right"),
          // Nothing to recommend here: widely used ones instead (D406).
          h(
            "span",
            { class: "ext-section-title" },
            items.every((i) => i.source === "popular") ? "Popular" : "Recommended",
          ),
          h("span", { class: "ext-section-count" }, busy ? "" : String(items.length)),
        ),
      );
    if (!open) return out;
    for (const r of items) {
      const [namespace = r.id, ...rest] = r.id.split(".");
      const item: StoreItem = r.details ?? {
        id: r.id.toLowerCase(),
        namespace,
        name: rest.join("."),
        displayName: rest.join(".") || r.id,
        description: "",
        version: "",
      };
      out.push(this.storeRow(item, r.reason));
    }
    return out;
  }

  /** Open VSX's results for what's typed (D254): Install, or Installed / Update. */
  private storeSection(q: string, header = true): HTMLElement[] {
    const results = storeResults.peek();
    if (
      !storeSearched(q) ||
      this.services.settings.peek<boolean>("extensions.store.enabled") === false
    )
      return [];
    const current = results.query === q;
    const open = !header || !this.collapsed.has("store");
    const out: HTMLElement[] = [];
    if (header)
      out.push(
        h(
          "button",
          {
            class: "ext-section",
            type: "button",
            "data-section": "store",
            "aria-expanded": String(open),
          },
          icon(open ? "chevron-down" : "chevron-right"),
          h("span", { class: "ext-section-title" }, "Open VSX"),
          h(
            "span",
            { class: "ext-section-count" },
            current && !results.busy && !results.error ? String(results.total) : "",
          ),
        ),
      );
    if (!open) return out;
    if (results.busy || !current) out.push(h("div", { class: "ext-none" }, "Searching Open VSX…"));
    else if (results.error)
      out.push(h("div", { class: "ext-none" }, `Open VSX couldn't be searched: ${results.error}`));
    else if (!results.items.length)
      out.push(h("div", { class: "ext-none" }, "Nothing found on Open VSX."));
    else for (const item of results.items) out.push(this.storeRow(item));
    return out;
  }

  /**
   * An Open VSX extension (a search result, or a recommendation with its `reason`): its icon,
   * name, description, publisher, downloads and rating, Install / Update / Installed. Clicking it
   * opens its store page.
   */
  private storeRow(item: StoreItem, reason?: string): HTMLElement {
    const installed = this.manager.get(item.id)?.manifest?.version;
    const update = storeUpdates.peek().find((u) => u.id === item.id);
    const installing = storeInstalling.peek().has(item.id);
    const action = installing
      ? h("span", { class: "ext-store-installed" }, installed ? "Updating…" : "Installing…")
      : installed && !update
        ? h("span", { class: "ext-store-installed" }, "Installed")
        : update
          ? h(
              "button",
              {
                class: "button button-accent button-sm",
                type: "button",
                "data-install": item.id,
                "aria-label": `Update ${item.displayName}`,
              },
              "Update",
            )
          : // Install ▾ (D284, VS Code's): the ▾ offers a specific version.
            h(
              "span",
              { class: "ext-split" },
              h(
                "button",
                {
                  class: "button button-secondary button-sm",
                  type: "button",
                  "data-install": item.id,
                  "aria-label": `Install ${item.displayName}`,
                },
                "Install",
              ),
              installMore(this.services, item.id, "button-secondary"),
            );
    let ignore: HTMLElement | null = null;
    if (reason && !installed) {
      ignore = h(
        "button",
        {
          class: "icon-button ext-gear",
          type: "button",
          "data-command": "extensions.ignoreRecommendation",
          "aria-label": `Don't recommend ${item.displayName}`,
        },
        icon("x"),
      );
      setTooltip(ignore, "Don't recommend it again");
    }
    const downloads =
      item.downloads !== undefined
        ? h("span", { class: "ext-store-stat" }, icon("download"), formatCount(item.downloads))
        : null;
    const row = h(
      "div",
      {
        class: { "ext-row": true, "ext-store-row": true },
        role: "listitem",
        tabindex: "0",
        "data-store-ext": item.id,
      },
      storeAvatar(item, "md", true),
      h(
        "div",
        { class: "ext-row-main" },
        h(
          "div",
          { class: "ext-row-line" },
          h("span", { class: "ext-name" }, item.displayName),
          item.version ? h("span", { class: "ext-version" }, item.version) : null,
        ),
        h("div", { class: "ext-desc" }, item.description || reason || ""),
        h(
          "div",
          { class: "ext-row-line ext-row-meta" },
          h("span", { class: "ext-publisher" }, item.namespace),
          item.verified ? verifiedMark() : null,
          downloads,
          item.rating
            ? h("span", { class: "ext-store-stat" }, icon("star"), item.rating.toFixed(1))
            : null,
          h("span", { class: "ext-row-spacer" }),
          ignore,
          action,
        ),
      ),
    );
    if (reason) setTooltip(row, `${item.id}: ${reason}`);
    return row;
  }

  private row(r: ExtensionRecord): HTMLElement {
    const m = r.manifest;
    const gear = h(
      "button",
      { class: "icon-button ext-gear", type: "button", "aria-label": "Manage" },
      icon("settings"),
    );
    setTooltip(gear, "Manage");
    // A newer version on Open VSX: VS Code's Update button on the row (D284).
    const pending = pendingUpdate(r.id);
    let update: HTMLElement | null = null;
    if (pending?.installing) update = h("span", { class: "ext-store-installed" }, "Updating…");
    else if (pending) {
      update = h(
        "button",
        {
          class: "button button-accent button-sm ext-allow",
          type: "button",
          "data-update": r.id,
          "aria-label": `Update ${m?.displayName ?? r.id} to ${pending.latest}`,
        },
        "Update",
      );
      setTooltip(update, `Update to ${pending.latest}`);
    }
    // Its authors' names when it lists them (D185), else the publisher part of its id.
    const publisher = m?.authors.length
      ? authorsText(m.authors)
      : m?.publisher || r.id.split(".")[0] || "";
    return h(
      "div",
      {
        class: { "ext-row": true, "is-disabled": r.status === "disabled" },
        role: "listitem",
        tabindex: "0",
        "data-ext": r.id,
      },
      avatar(r),
      h(
        "div",
        { class: "ext-row-main" },
        h(
          "div",
          { class: "ext-row-line" },
          h("span", { class: "ext-name" }, m?.displayName ?? r.id),
          h("span", { class: "ext-version" }, m?.version ?? ""),
        ),
        h(
          "div",
          { class: "ext-desc" },
          r.error && r.status !== "active" ? r.error : (m?.description ?? ""),
        ),
        h(
          "div",
          { class: "ext-row-line ext-row-meta" },
          h("span", { class: "ext-publisher" }, publisher),
          fromStore(r) && isVerified(r.id) ? verifiedMark() : null,
          ...badges(r),
          h("span", { class: "ext-row-spacer" }),
          update,
          gear,
        ),
      ),
    );
  }

  private foundRow(f: WorkspaceExtension): HTMLElement {
    const action = (label: string, command: string, primary = false) =>
      h(
        "button",
        {
          class: `button ${primary ? "button-accent" : "button-ghost"} button-sm`,
          type: "button",
          "data-command": command,
          "data-folder": f.root,
        },
        label,
      );
    return h(
      "div",
      { class: { "ext-row": true, "ext-found": true, "is-invalid": !!f.error }, role: "listitem" },
      h(
        "span",
        { class: "ext-avatar ext-found-avatar" },
        icon(f.error ? "circle-alert" : "folder"),
      ),
      h(
        "div",
        { class: "ext-row-main" },
        h(
          "div",
          { class: "ext-row-line" },
          h("span", { class: "ext-name" }, f.displayName ?? f.name),
        ),
        h(
          "div",
          { class: { "ext-desc": true, "is-error": !!f.error } },
          f.error ?? "In this folder, not loaded yet.",
        ),
        h(
          "div",
          { class: "ext-row-line ext-row-meta" },
          h("span", { class: "ext-publisher" }, this.services.workspace.relative(f.root)),
          h("span", { class: "ext-row-spacer" }),
          action("Show folder", "extensions.revealFolder"),
          f.error ? null : action("Load", "extensions.loadFromWorkspace", true),
        ),
      ),
    );
  }

  focus(): void {
    (this.list.querySelector(".ext-row") as HTMLElement | null)?.focus();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.store.dispose();
  }
}
