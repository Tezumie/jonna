// The "settings" dock tab (DESIGN.md §12.16, redesigned in D121 after Cursor's settings): a left
// navigation of categories (an icon rail when the tab is narrow), one category per page with its
// settings in a card — title and description on the left, the control on the right — and search
// across everything (results grouped by category). User · Workspace switcher (· Folder, with a
// folder picker, in a multi-root workspace, D251), reset, settings.json.
// Built from the contributed schemas, so extension settings appear automatically. Rows are rebuilt
// only when scope, query, page or registry change; value changes update rows in place.
import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect, signal } from "../../core/reactive/index";
import { normalizeLanguageId } from "../../core/settings/languageOverrides";
import { confirmAction, confirmWithOptions } from "../../ui/Dialog";
import { type IconName, icon } from "../../ui/Icon";
import { showContextMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { inspectScope, type SettingRow, settingRow } from "./controls";
import type { EditScope } from "./folderScope";
import {
  groupByExtension,
  isLink,
  pageSections,
  pagesFor,
  SETTINGS_GROUPS,
  type SettingsPage,
} from "./pages";
import { filterTitle, hasFilter, matchesSetting, parseSettingsQuery } from "./searchQuery";

export function settingsViewDescriptor(services: WorkbenchServices): DockViewDescriptor {
  return {
    type: "settings",
    title: () => "Settings",
    icon: () => "settings",
    singleton: true,
    defaultPlacement: "main",
    editorLike: true,
    create: (state) => {
      const scope = stateField(state, "scope");
      const folder = stateField(state, "folder");
      return new SettingsView(
        services,
        scope === "workspace" || scope === "folder" ? scope : "user",
        typeof folder === "string" ? folder : null,
      );
    },
  };
}

export class SettingsView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly rows = this.store.add(new DisposableStore());
  private readonly scope = signal<EditScope>("user");
  /** The folder the "folder" scope edits (a multi-root workspace's, D251). */
  private readonly folder = signal<string | null>(null);
  private readonly query = signal("");
  /** The page shown when not searching: a page id, or ALL (every setting, by page). */
  private readonly page = signal<string | null>(ALL);
  private readonly pageTitle: HTMLElement;
  /** The search box: in the navigation, and in the header when the tab is narrow. */
  private readonly searches: HTMLInputElement[];
  private queryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly list: HTMLElement;
  private readonly toc: HTMLElement;
  private readonly scroller: HTMLElement;
  private live: SettingRow[] = [];

  constructor(
    private readonly services: WorkbenchServices,
    initialScope: EditScope = "user",
    initialFolder: string | null = null,
  ) {
    const { settings, workspace } = services;
    this.scope.value = initialScope;
    this.folder.value = initialFolder;
    const segment = (scope: EditScope, label: string) => {
      const b = h("button", { class: "segment", type: "button", role: "tab" }, label);
      this.store.add(
        on(b, "click", () => {
          if (!b.disabled) this.scope.value = scope;
        }),
      );
      return b;
    };
    const userTab = segment("user", "User");
    const workspaceTab = segment("workspace", "Workspace");
    const folderTab = segment("folder", "Folder");
    // Which folder the Folder scope edits (several folders).
    const folderSelect = h("select", {
      class: "input settings-folder-select",
      "aria-label": "Folder",
    }) as HTMLSelectElement;
    this.store.add(
      on(folderSelect, "change", () => {
        this.folder.value = folderSelect.value || null;
      }),
    );
    const searchBox = (where: string) => {
      const input = h("input", {
        class: "input settings-search-input",
        type: "search",
        placeholder: "Search settings",
        spellcheck: "false",
        "aria-label": "Search settings",
      });
      this.store.add(
        on(input, "input", () => {
          for (const other of this.searches) if (other !== input) other.value = input.value;
          // Typing settles first (D379): each query rebuilds the page (filter, rows, nav).
          clearTimeout(this.queryTimer);
          this.queryTimer = setTimeout(() => {
            this.query.value = input.value;
          }, QUERY_DEBOUNCE_MS);
        }),
      );
      return {
        input,
        element: h("div", { class: `settings-search ${where}` }, icon("search"), input),
      };
    };
    const navSearch = searchBox("is-nav");
    const headerSearch = searchBox("is-header");
    this.searches = [navSearch.input, headerSearch.input];
    const openJson = h("button", { class: "icon-button", type: "button" }, icon("braces"));
    setTooltip(openJson, "Open settings.json", "settings.openJson");
    this.store.add(
      on(openJson, "click", () => {
        void services.dispatcher.execute("settings.openJson", this.where()).catch(() => {});
      }),
    );
    this.resetAll = h("button", { class: "icon-button", type: "button" }, icon("rotate-ccw"));
    this.store.add(on(this.resetAll, "click", () => void this.reset(null)));
    this.toc = h("div", { class: "settings-nav-items" });
    this.list = h("div", { class: "settings-list" });
    this.pageTitle = h("h1", { class: "settings-page-title" });
    this.scroller = h(
      "div",
      { class: "settings-scroll" },
      h(
        "div",
        { class: "settings-page-head" },
        this.pageTitle,
        h(
          "div",
          { class: "settings-page-tools" },
          h("div", { class: "segmented", role: "tablist" }, userTab, workspaceTab, folderTab),
          folderSelect,
          this.resetAll,
          openJson,
        ),
      ),
      this.list,
    );
    this.element = h(
      "div",
      { class: "settings-view", tabindex: "-1" },
      h(
        "div",
        { class: "settings-layout" },
        h(
          "nav",
          { class: "settings-nav", "aria-label": "Settings pages" },
          navSearch.element,
          this.toc,
        ),
        h("div", { class: "settings-main" }, headerSearch.element, this.scroller),
      ),
    );

    this.store.add(
      effect(() => {
        const open = workspace.root.value !== null;
        const folders = workspace.folders.value;
        // Folders exist as their own scope in a multi-root workspace only (as in VS Code).
        const multiRoot = workspace.file.value !== null;
        if (!open && this.scope.value !== "user") this.scope.value = "user";
        if (!multiRoot && this.scope.value === "folder") this.scope.value = "workspace";
        // The folder edited: kept while it's in the workspace, else the first.
        if (multiRoot) {
          const kept = folders.find((f) => f.path === this.folder.peek());
          if (!kept) this.folder.value = folders[0]?.path ?? null;
        }
        workspaceTab.disabled = !open;
        folderTab.hidden = !multiRoot;
        setTooltip(
          workspaceTab,
          !open
            ? "Open a folder to use workspace settings"
            : multiRoot
              ? "Settings for every folder of this workspace (in the workspace file)"
              : "Settings for this folder",
        );
        setTooltip(
          folderTab,
          "Settings of one folder (its own settings.json; they win for its files)",
        );
        setTooltip(userTab, "Settings for every folder");
        const scope = this.scope.value;
        userTab.classList.toggle("is-selected", scope === "user");
        workspaceTab.classList.toggle("is-selected", scope === "workspace");
        folderTab.classList.toggle("is-selected", scope === "folder");
        folderSelect.hidden = !(multiRoot && scope === "folder" && folders.length > 1);
        const chosen = this.folder.value;
        folderSelect.replaceChildren(
          ...folders.map((f) => {
            const option = h("option", { value: f.path }, f.name);
            option.title = f.path;
            return option;
          }),
        );
        folderSelect.value = chosen ?? "";
        return undefined;
      }),
    );
    let registryVersion = -1;
    this.store.add(
      effect(() => {
        const scope = this.scope.value;
        const folder = scope === "folder" ? (this.folder.value ?? "") : "";
        const query = this.query.value.trim().toLowerCase();
        const page = this.page.value;
        settings.version.value;
        if (
          registryVersion !== settings.registry.changeCount ||
          this.builtFor !== `${scope}\0${folder}\0${query}\0${page}`
        ) {
          registryVersion = settings.registry.changeCount;
          this.build(scope, query);
        } else {
          for (const row of this.live) row.update();
        }
        this.updateResets();
        return undefined;
      }),
    );
  }

  private builtFor = "";
  private readonly resetAll: HTMLButtonElement;
  /** Each section's reset button, with its keys. */
  private sectionResets: { keys: string[]; button: HTMLElement }[] = [];

  /** The language the search's `@lang:` names (D201): rows show and edit its block. */
  private language: string | undefined;

  /** The folder edited: the Folder scope's (null in the other scopes). */
  private folderOfScope(): string | null {
    return this.scope.peek() === "folder" ? this.folder.peek() : null;
  }

  /** The scope (and its folder) as the settings commands take it. */
  private where(): { scope: EditScope; folder?: string } {
    const folder = this.folderOfScope();
    return folder ? { scope: this.scope.peek(), folder } : { scope: this.scope.peek() };
  }

  private modified(keys: readonly string[] | null): string[] {
    const scope = this.scope.peek();
    const folder = this.folderOfScope();
    const language = this.language;
    return (keys ?? this.services.settings.registry.all().map((s) => s.key)).filter(
      (k) => inspectScope(this.services, scope, folder, k, language) !== undefined,
    );
  }

  private updateResets(): void {
    const scope = this.scope.peek();
    const changed = new Set(this.modified(null));
    const any = changed.size;
    this.resetAll.disabled = any === 0;
    setTooltip(
      this.resetAll,
      any ? `Reset all ${scope} settings (${any} changed)` : `No ${scope} settings changed`,
    );
    for (const { keys, button } of this.sectionResets)
      button.hidden = !keys.some((k) => changed.has(k));
  }

  /** A row that opens a page instead of holding a value (CATEGORY_LINKS). */
  private linkRow(link: CategoryLink): HTMLElement {
    const row = h(
      "button",
      { class: "settings-link-row", type: "button", "data-command": link.command },
      h("span", { class: "settings-link-icon" }, icon(link.icon)),
      h(
        "span",
        { class: "settings-link-text" },
        h("span", { class: "settings-link-label" }, link.label),
        h("span", { class: "settings-link-detail" }, link.detail),
      ),
      icon("chevron-right"),
    );
    this.rows.add(
      on(row, "click", () => void this.services.dispatcher.execute(link.command).catch(() => {})),
    );
    return row;
  }

  /** Resets some settings (`null`: everything) in the current scope after asking. */
  private async reset(keys: readonly string[] | null, label?: string): Promise<void> {
    const changed = this.modified(keys);
    if (!changed.length) return;
    const scope = this.scope.peek();
    const language = this.language;
    const what =
      keys === null
        ? language
          ? `all ${language} settings in ${scope} settings`
          : `all ${scope} settings`
        : `the ${label ?? "section's"} settings${language ? ` for ${language}` : ""}`;
    // Model providers and their keys are kept unless asked (D166): most services show a key only
    // once, so an accidental reset would mean making new ones.
    const providers =
      !language &&
      scope === "user" &&
      this.services.dispatcher.has("agent.forgetProviders") &&
      changed.some((k) => PROVIDER_KEYS.includes(k));
    // Resetting everything keeps the agent's settings unless asked too (D275): its models, its
    // agents and their choices are set up over time, not tried on the way.
    const agentKeys =
      keys === null
        ? changed.filter((k) => k.startsWith(AGENT_PREFIX) && !PROVIDER_KEYS.includes(k))
        : [];
    const shown = changed.filter(
      (k) => !(providers && PROVIDER_KEYS.includes(k)) && !agentKeys.includes(k),
    );
    const back =
      scope === "folder"
        ? "the workspace, user or default values"
        : scope === "workspace"
          ? "the user or default values"
          : "their defaults";
    const message = shown.length
      ? `${shown.length} setting${shown.length === 1 ? "" : "s"} go back to ${back}: ${shown.slice(0, 8).join(", ")}${shown.length > 8 ? "…" : ""}`
      : `Only the agent's settings are changed: check below to reset them to ${back}.`;
    const choices = [
      ...(agentKeys.length ? [agentOption(agentKeys)] : []),
      ...(providers ? [PROVIDERS_OPTION] : []),
    ];
    const answer = choices.length
      ? await confirmWithOptions(`Reset ${what}?`, message, "Reset", choices, true)
      : { ok: await confirmAction(`Reset ${what}?`, message, "Reset", true), options: [] };
    if (!answer.ok) return;
    const resetAgent = agentKeys.length > 0 && answer.options[0] === true;
    const removeProviders = providers && answer.options[choices.length - 1] === true;
    if (!shown.length && !resetAgent && !removeProviders) return;
    const kept = [
      ...(providers && !removeProviders ? PROVIDER_KEYS : []),
      ...(resetAgent ? [] : agentKeys),
    ];
    const target = language
      ? { keys: changed.filter((k) => !kept.includes(k)), language }
      : keys === null
        ? { all: true }
        : { keys: [...keys] };
    await this.services.dispatcher
      .execute("settings.reset", {
        ...target,
        ...this.where(),
        ...(kept.length && { except: kept }),
      })
      .catch(() => {});
    if (removeProviders)
      await this.services.dispatcher.execute("agent.forgetProviders").catch(() => {});
  }

  private sectionMenu(keys: readonly string[], label: string, x: number, y: number): void {
    const scope = this.scope.peek();
    const changed = this.modified(keys).length;
    const all = this.modified(null).length;
    showContextMenu(x, y, [
      {
        label: `Reset ${label} settings`,
        icon: "undo-2",
        disabled: changed === 0,
        keybinding: changed ? `${changed} changed` : undefined,
        run: () => void this.reset(keys, label),
      },
      {
        label: `Reset all ${scope} settings`,
        icon: "undo-2",
        disabled: all === 0,
        keybinding: all ? `${all} changed` : undefined,
        run: () => void this.reset(null),
      },
      {
        label: "Show only changed settings",
        icon: "list-filter",
        separatorBefore: true,
        run: () => this.configure(undefined, "@modified"),
      },
      {
        label: "Open settings.json",
        icon: "file-json",
        run: () =>
          void this.services.dispatcher.execute("settings.openJson", this.where()).catch(() => {}),
      },
    ]);
  }

  private setQuery(value: string): void {
    for (const input of this.searches) input.value = value;
    this.query.value = value;
  }

  private build(scope: EditScope, query: string): void {
    const folder = this.folderOfScope();
    this.builtFor = `${scope}\0${folder ?? ""}\0${query}\0${this.page.peek()}`;
    this.rows.clear();
    this.live = [];
    // An extension's settings on one page of its own, its configuration titles as sections.
    const inScope = groupByExtension(
      this.services.settings.registry
        .all()
        .filter((s) => !s.deprecated)
        .filter((s) => (scope !== "user" ? s.scope !== "user" : s.scope !== "workspace")),
    );
    const { groups, pageOf } = pagesFor([...new Set(inScope.map((s) => s.category))]);
    const pages = groups.flatMap((g) => g.items.filter((i): i is SettingsPage => !isLink(i)));
    const searching = query !== "";
    // `@modified`, `@id:`, `@ext:`, `@tag:`, `@lang:` and words (searchQuery.ts).
    const parsed = parseSettingsQuery(query);
    const filtered = hasFilter(parsed);
    const named = searching ? parsed.languages[0] : undefined;
    this.language = named ? normalizeLanguageId(named) : undefined;
    const language = this.language;
    // The page: the chosen one, else everything (a page may have gone with a scope switch).
    const chosen = this.page.peek();
    const current = pages.find((p) => p.id === chosen);
    const all = !current;
    const isModified = (key: string) =>
      inspectScope(this.services, scope, folder, key, language) !== undefined;
    const shown = inScope.filter((s) =>
      searching
        ? matchesSetting(s, parsed, isModified)
        : all || current.categories.includes(s.category),
    );
    this.sectionResets = [];
    let built = 0;
    const later: { element: HTMLElement; card: HTMLElement; fill(): void; rows: number }[] = [];
    const sectionEls: HTMLElement[] = [];
    const sectionIds = new Map<string, string>();
    const listed = searching || all ? pages : [current];
    for (const page of listed) {
      const sections = pageSections(page, shown);
      for (const section of sections) {
        const keys = section.settings.map((x) => x.key);
        const label =
          searching || all
            ? page.title === section.title
              ? page.title
              : `${page.title} › ${section.title}`
            : section.title === page.title
              ? ""
              : section.title;
        const sectionReset = h(
          "button",
          { class: "icon-button setting-reset settings-section-reset", type: "button" },
          icon("rotate-ccw"),
        );
        setTooltip(sectionReset, `Reset ${label || page.title} settings`);
        this.rows.add(on(sectionReset, "click", () => void this.reset(keys, label || page.title)));
        this.sectionResets.push({ keys, button: sectionReset });
        const heading = h(
          "h2",
          { class: "settings-section-title" },
          h("span", null, label),
          sectionReset,
        );
        const card = h("div", { class: "settings-card" });
        const id = `settings-section-${sectionEls.length}`;
        sectionIds.set(`${page.id}\0${section.title}`, id);
        const element = h("section", { class: "settings-section", id }, heading, card);
        // About its height until it's first shown (then its own, as the browser remembers it).
        element.style.containIntrinsicSize = `auto ${section.settings.length * ESTIMATED_ROW_PX + SECTION_HEAD_PX}px`;
        this.rows.add(
          on(heading, "contextmenu", (e) => {
            e.preventDefault();
            this.sectionMenu(keys, label || page.title, e.clientX, e.clientY);
          }),
        );
        const fill = () => {
          for (const info of section.settings) {
            const row = settingRow(info, scope, parsed.text, this.services, language, folder);
            this.rows.add(row);
            this.live.push(row);
            card.append(row.element);
          }
        };
        // The first screens' rows now; a later section's when it scrolls near (D275: building and
        // laying out every row of All settings made opening it, and each change, lag).
        if (built < EAGER_ROWS) {
          built += section.settings.length;
          fill();
        } else later.push({ element, card, fill, rows: section.settings.length });
        sectionEls.push(element);
      }
      // Pages a page's settings lead to (the agent's models, D165), above its first section.
      const first = sectionEls.find(
        (el) => el.id === sectionIds.get(`${page.id}\0${sections[0]?.title}`),
      );
      if (first && !filtered)
        for (const link of CATEGORY_LINKS[page.id] ?? []) {
          if (!this.services.dispatcher.has(link.command)) continue;
          if (searching && !`${link.label} ${link.detail}`.toLowerCase().includes(parsed.text))
            continue;
          first.insertBefore(this.linkRow(link), first.querySelector(".settings-card"));
        }
    }
    this.renderNav(
      groups,
      current,
      searching,
      new Set(shown.map((s) => pageOf(s.category)?.id)),
      sectionIds,
    );
    this.pageTitle.textContent = searching
      ? filterTitle(parsed, shown.length)
      : current
        ? current.title
        : "All settings";
    this.updateResets();
    this.list.replaceChildren(
      ...(sectionEls.length > 0
        ? sectionEls
        : [h("div", { class: "empty-state-text settings-empty" }, "No settings found.")]),
    );
    this.fillLater(later);
    this.scroller.scrollTo({ top: 0 });
  }

  /**
   * Sections whose rows are built once they come within a few screens of the view; until then
   * a card holds about their height, so the scrollbar and the navigation's jumps stay right.
   */
  private fillLater(
    sections: readonly { element: HTMLElement; card: HTMLElement; fill(): void; rows: number }[],
  ): void {
    if (!sections.length) return;
    const waiting = new Map(sections.map((s) => [s.element as Element, s]));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const section = entry.isIntersecting ? waiting.get(entry.target) : undefined;
          if (!section) continue;
          waiting.delete(entry.target);
          observer.unobserve(entry.target);
          section.card.style.minHeight = "";
          section.fill();
        }
        if (entries.some((e) => e.isIntersecting)) this.updateResets();
      },
      { root: this.scroller, rootMargin: "600px 0px" },
    );
    for (const s of sections) {
      s.card.style.minHeight = `${s.rows * ESTIMATED_ROW_PX}px`;
      observer.observe(s.element);
    }
    this.rows.add({ dispose: () => observer.disconnect() });
  }

  /** The navigation: groups with dividers; the open page's sections under it; links with ↗. */
  private renderNav(
    groups: ReturnType<typeof pagesFor>["groups"],
    current: SettingsPage | undefined,
    searching: boolean,
    matches: Set<string | undefined>,
    sectionIds: Map<string, string>,
  ): void {
    const go = (page: string) => {
      if (this.query.peek()) this.setQuery("");
      this.page.value = page;
    };
    const item = (
      label: string,
      iconName: IconName,
      selected: boolean,
      dimmed: boolean,
      run: () => void,
      trailing?: HTMLElement,
    ) => {
      const el = h(
        "button",
        {
          class: { "settings-nav-item": true, "is-selected": selected, "is-dimmed": dimmed },
          type: "button",
          "aria-label": label,
          ...(selected && { "aria-current": "page" }),
        },
        icon(iconName),
        h("span", { class: "settings-nav-label" }, label),
        trailing ?? null,
      );
      setTooltip(el, label, undefined, { placement: "right" });
      this.rows.add(on(el, "click", run));
      return el;
    };
    const out: HTMLElement[] = [
      item("All settings", "list-chevrons-up-down", !searching && !current, false, () => go(ALL)),
    ];
    for (const group of groups) {
      out.push(h("div", { class: "settings-nav-separator", role: "separator" }));
      for (const entry of group.items) {
        if (isLink(entry)) {
          if (!this.services.dispatcher.has(entry.command)) continue;
          const el = item(
            entry.title,
            entry.icon,
            false,
            searching,
            () =>
              void this.services.dispatcher
                .execute(entry.command, entry.input ?? {})
                .catch(() => {}),
            h("span", { class: "settings-nav-arrow" }, icon("arrow-up-right")),
          );
          el.classList.add("is-link");
          setTooltip(el, entry.detail, undefined, { placement: "right" });
          out.push(el);
          continue;
        }
        const selected = !searching && current?.id === entry.id;
        out.push(
          item(entry.title, entry.icon, selected, searching && !matches.has(entry.id), () =>
            go(entry.id),
          ),
        );
        // The open page's sections, like a docs page's contents: click to jump there.
        if (selected) {
          const sections = [...sectionIds.keys()]
            .filter((k) => k.startsWith(`${entry.id}\0`))
            .map((k) => k.slice(entry.id.length + 1));
          if (sections.length > 1)
            for (const title of sections) {
              const sub = h(
                "button",
                { class: "settings-nav-sub", type: "button" },
                title === entry.title ? "General" : title,
              );
              this.rows.add(
                on(sub, "click", () => {
                  const id = sectionIds.get(`${entry.id}\0${title}`);
                  if (id) this.list.querySelector(`#${id}`)?.scrollIntoView({ block: "start" });
                }),
              );
              out.push(sub);
            }
        }
      }
    }
    this.toc.replaceChildren(...out);
  }

  /** Switches scope and/or search (settings.open with arguments); `folder` for the Folder scope. */
  configure(scope?: EditScope, query?: string, category?: string, folder?: string): void {
    const { workspace } = this.services;
    if (scope === "folder" && !workspace.isMultiRoot()) scope = "workspace";
    if (scope && (scope === "user" || workspace.root.peek())) this.scope.value = scope;
    if (folder) {
      const found = workspace.folders.peek().find((f) => f.path === folder || f.name === folder);
      if (found) this.folder.value = found.path;
    }
    if (category !== undefined) {
      // A page by its id, its title or one of its categories ("Agent", "Editor").
      const lower = category.toLowerCase();
      const page = SETTINGS_GROUPS.flatMap((g) => g.items)
        .filter((i): i is SettingsPage => !isLink(i))
        .find(
          (p) =>
            p.id === lower ||
            p.title.toLowerCase() === lower ||
            p.categories.some((c) => c.toLowerCase() === lower),
        );
      // A category page: the search is cleared so the page shows.
      this.setQuery("");
      this.page.value = page?.id ?? `category:${category}`;
    }
    if (query !== undefined) this.setQuery(query);
  }

  focus(): void {
    // The navigation's box, or the header's when the navigation is a rail (only one shows).
    (this.searches.find((i) => i.offsetParent !== null) ?? this.searches[0])?.focus();
  }

  serialize(): Json {
    const folder = this.folderOfScope();
    return folder ? { scope: this.scope.peek(), folder } : { scope: this.scope.peek() };
  }

  dispose(): void {
    clearTimeout(this.queryTimer);
    this.store.dispose();
  }
}

/** The "All settings" page. */
const ALL = "\0all";

/** Rows built when a page opens (a tall window's worth); the rest as they scroll near. */
const EAGER_ROWS = 40;
/** Typing in the search settles this long before the page is filtered again (D379). */
const QUERY_DEBOUNCE_MS = 120;
/** About a row's height, for a section not built yet. */
const ESTIMATED_ROW_PX = 64;
/** About a section's label above its card. */
const SECTION_HEAD_PX = 28;

/** Settings that hold the connected model providers: kept by a reset unless asked (D166). */
const PROVIDER_KEYS = ["agent.providers"];
const PROVIDERS_OPTION = {
  label: "Also remove connected model providers and their API keys",
  detail: "You'd have to paste the keys again; most services show a key only once.",
};
/** The agent's settings: kept by Reset all unless asked (D275). */
const AGENT_PREFIX = "agent.";
function agentOption(keys: readonly string[]): { label: string; detail: string } {
  return {
    label: `Also reset the agent's settings (${keys.length})`,
    detail: `Its models, agents and their choices, and the rest: ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? "…" : ""}.`,
  };
}

interface CategoryLink {
  label: string;
  detail: string;
  command: string;
  icon: IconName;
}

/** Pages opened from a category's settings, shown first in its card (D165). */
const CATEGORY_LINKS: Record<string, CategoryLink[]> = {
  agent: [
    {
      label: "Customize",
      detail:
        "Models and providers, agents and subagents, rules, skills, commands, auto-approve, MCP servers and docs, in one tab.",
      command: "agent.customize",
      icon: "sliders-horizontal",
    },
  ],
  mcp: [
    {
      label: "Configure MCP servers",
      detail:
        "The servers the agent uses: turn them or their tools on or off, sign in, add one (Customize → MCP servers).",
      command: "agent.showMcpPage",
      icon: "server",
    },
  ],
};
